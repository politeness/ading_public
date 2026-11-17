package com.politeness.ading.ops.dal.mapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.politeness.ading.ops.dal.OpsDeviceAccountRow;
import com.politeness.ading.ops.dal.OpsDeviceRow;
import java.sql.Connection;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactory;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Actually runs the SQL in the Mappers (H2 in-memory database, MySQL compatibility mode) to pin down what mocks can't test:
 * one row per device, all linked accounts are listed, and the row count filtered by account matches the number in the user list;
 * and that the collection's "read then write" upsert statement itself is correct.
 */
class MapperSqlTest {

    private static final LocalDateTime ONLINE_SINCE = LocalDateTime.parse("2026-11-03T12:00:00");
    private static final LocalDateTime ACTIVE_SINCE = LocalDateTime.parse("2026-10-05T00:00:00");

    private JdbcDataSource dataSource;
    private Connection keepAlive;
    private SqlSession session;

    @BeforeEach
    void setUp() throws Exception {
        dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:ops_mapper_" + System.nanoTime() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        keepAlive = dataSource.getConnection();
        try (Statement st = keepAlive.createStatement()) {
            st.execute("""
                    CREATE TABLE users (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(64), username VARCHAR(64),
                      display_name VARCHAR(64), phone VARCHAR(32), email VARCHAR(128), status VARCHAR(16),
                      is_agent TINYINT DEFAULT 0, owner VARCHAR(64), agent_type VARCHAR(32),terminal_id VARCHAR(64),readiness VARCHAR(32), gmt_created DATETIME)""");
            st.execute("CREATE TABLE users_rel (user_id VARCHAR(64), friend_id VARCHAR(64), status VARCHAR(16))");
            st.execute("CREATE TABLE user_tags (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(64), tag VARCHAR(32))");
            st.execute("""
                    CREATE TABLE terminals (id BIGINT AUTO_INCREMENT PRIMARY KEY, terminal_id VARCHAR(64), name VARCHAR(64),
                      status VARCHAR(16), owner VARCHAR(64), fingerprint VARCHAR(128), type VARCHAR(16),
                      gmt_created DATETIME DEFAULT CURRENT_TIMESTAMP, gmt_modified DATETIME DEFAULT CURRENT_TIMESTAMP, last_seen_at DATETIME,
                      UNIQUE (owner, fingerprint))""");
            st.execute("""
                    CREATE TABLE devices (id BIGINT AUTO_INCREMENT PRIMARY KEY, device_uuid VARCHAR(128) UNIQUE, device_type VARCHAR(16),
                      name VARCHAR(100), os_version VARCHAR(64), app_version VARCHAR(50), city VARCHAR(64), agents VARCHAR(255),
                      first_seen_at DATETIME, last_active_at DATETIME)""");
            st.execute("""
                    CREATE TABLE terminal_sessions (id BIGINT AUTO_INCREMENT PRIMARY KEY, terminal_id VARCHAR(64), device_uuid VARCHAR(128),
                      user_id VARCHAR(64), online_at DATETIME, offline_at DATETIME, last_seen_at DATETIME, open_terminal_id VARCHAR(64) UNIQUE)""");
            st.execute("CREATE TABLE device_telemetry (device_uuid VARCHAR(128) UNIQUE, user_id VARCHAR(64), agents VARCHAR(255))");
            st.execute("""
                    CREATE TABLE device_telemetry_hour (stat_hour DATETIME, device_uuid VARCHAR(128), user_id VARCHAR(64),
                      device_type VARCHAR(16), reported_at DATETIME, UNIQUE (stat_hour, device_uuid))""");
            st.execute("INSERT INTO users (user_id, username, display_name, phone, email) VALUES "
                    + "('u_a', 'alice', 'A', '13800000001', 'a@x.com'), ('u_b', 'bob', 'B', '13800000002', 'b@x.com')");
            // mac-1 was logged into by alice and then bob: two nodes; the latest report is alice (the ping carries alice's phone number)
            st.execute("INSERT INTO terminals (terminal_id, name, status, owner, fingerprint, type) VALUES "
                    + "('t_a1', 'Alice 的 Mac', 'ONLINE', 'u_a', 'mac-1', 'MAC'),"
                    + "('t_b1', 'Bob 借用', 'OFFLINE', 'u_b', 'mac-1', 'MAC'),"
                    + "('t_b2', 'Bob 自己的', 'ONLINE', 'u_b', 'mac-2', 'MAC')");
            st.execute("INSERT INTO devices (device_uuid, device_type, name, app_version, city, agents, first_seen_at, last_active_at) VALUES "
                    + "('mac-1', 'mac', '两个账号的 Mac', '0.11.0', '上海', 'codex,qoder', '2026-10-01 10:00:00', '2026-10-30 14:00:00'),"
                    + "('mac-2', 'mac', 'Bob 的 Mac', NULL, '杭州', NULL, '2026-10-02 10:00:00', '2026-10-30 13:00:00'),"
                    + "('mac-3', 'mac', NULL, NULL, NULL, NULL, '2026-10-03 10:00:00', '2026-10-30 12:00:00')");
        }
        Configuration configuration = new Configuration(
                new Environment("test", new JdbcTransactionFactory(), dataSource));
        configuration.setMapUnderscoreToCamelCase(true);
        StatisticsExclusions.apply(configuration, " Review_Account, review_account2 ");
        configuration.addMapper(OpsDeviceMapper.class);
        configuration.addMapper(ActivityMapper.class);
        configuration.addMapper(OpsUserMapper.class);
        configuration.addMapper(ActiveMemberMapper.class);
        SqlSessionFactory factory = new SqlSessionFactoryBuilder().build(configuration);
        session = factory.openSession(true);
    }

    @AfterEach
    void tearDown() throws Exception {
        try {
            if (session != null) {
                session.close();
            }
        } finally {
            // The in-memory database is discarded entirely when the last connection closes, leaving no intermediate data
            try (Statement st = keepAlive.createStatement()) {
                st.execute("DROP ALL OBJECTS");
            } finally {
                keepAlive.close();
            }
        }
    }

    private void exec(String sql) throws Exception {
        try (Statement st = keepAlive.createStatement()) {
            st.execute(sql);
        }
    }

    /** This terminal has an open session, with the connection last observed at lastSeen */
    private void connected(String terminalId, String device, String user, String lastSeen) throws Exception {
        exec("INSERT INTO terminal_sessions (terminal_id, device_uuid, user_id, online_at, last_seen_at, open_terminal_id) VALUES ('"
                + terminalId + "', '" + device + "', '" + user + "', '" + lastSeen + "', '" + lastSeen + "', '" + terminalId + "')");
    }

    /** This desktop's window was in the foreground at at: the hour containing it has a ping row */
    private void foreground(String device, String user, String at) throws Exception {
        exec("INSERT INTO device_telemetry_hour (stat_hour, device_uuid, user_id, device_type, reported_at) VALUES ('"
                + at.substring(0, 13) + ":00:00', '" + device + "', " + (user == null ? "NULL" : "'" + user + "'") + ", 'mac', '" + at + "')");
    }

    /** A finished desktop connection: counts toward online duration only, not activity */
    private void onlineInterval(String device, String user, String start, String end) throws Exception {
        exec("INSERT INTO terminal_sessions (device_uuid,user_id,online_at,offline_at,last_seen_at) VALUES ('" + device + "',"
                + (user == null ? "NULL" : "'" + user + "'") + ",'" + start + "','" + end + "','" + end + "')");
    }

    private Map<String, OpsDeviceRow> listed(boolean registeredOnly, String owner, LocalDateTime activeSince) {
        return session.getMapper(OpsDeviceMapper.class).searchDevices(null, registeredOnly, null, owner, activeSince, ONLINE_SINCE, 0, 50).stream()
                .collect(Collectors.toMap(OpsDeviceRow::getDeviceUuid, Function.identity()));
    }

    @Test
    void appleReviewAccountsAndDevicesAreExcludedAcrossListsAndActivity() throws Exception {
        exec("INSERT INTO users (user_id, username, is_agent, owner) VALUES "
                + "('apple1', 'review_account', 0, NULL), ('apple2', 'review_account2', 0, NULL),"
                + "('near', 'review_account_extra', 0, NULL), ('apple-agent', 'review-agent', 1, 'apple1')");
        // A normal account shares mac-1 with reviewers: retain the device and normal activity.
        exec("INSERT INTO terminals (terminal_id, owner, fingerprint, status) VALUES ('review', 'apple1', 'mac-1', 'ONLINE')");
        // Second review device is telemetry-only, without a registered terminal.
        connected("review", "mac-1", "apple1", "2026-11-03 12:30:00");
        connected("t_b2", "mac-2", "u_b", "2026-11-03 12:30:00");
        foreground("mac-1", null, "2026-11-01 10:00:00");
        foreground("mac-2", "u_b", "2026-11-03 10:00:00");
        foreground("mac-3", "apple2", "2026-11-03 11:00:00");
        var users = session.getMapper(OpsUserMapper.class);
        var devices = session.getMapper(OpsDeviceMapper.class);
        var hours = session.getMapper(ActivityMapper.class);
        assertEquals(3, users.countRealUsers());
        assertEquals(3, users.countUsers(null));
        assertEquals(List.of("alice", "bob", "review_account_extra"), users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream().map(row -> row.getUsername()).sorted().toList(), "names are exact, not prefix matches");
        assertEquals(3, users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).size());
        assertEquals(0, users.countAgentRows(null, "apple1", false));
        assertEquals(0, users.searchAgents(null, "apple1", false, 0, 20).size());
        assertEquals(2, devices.countAllDevices());
        assertEquals(2, devices.countAllTerminals());
        assertEquals(2, devices.countOnlineTerminals(ONLINE_SINCE));
        assertEquals(2, devices.countDevices(null, false, null, null, null));
        assertEquals(2, devices.countDevices(null, true, ONLINE_SINCE, null, null));
        assertEquals(List.of("mac-1", "mac-2"), listed(false, null, null).keySet().stream().sorted().toList());
        assertEquals(2, devices.devicesByIds(List.of("mac-1", "mac-2", "mac-3"), ONLINE_SINCE).size());
        assertEquals(3, devices.accountsOf(List.of("mac-1", "mac-2", "mac-3"), ONLINE_SINCE).size());
        var from = LocalDateTime.parse("2026-11-01T00:00:00");
        var to = LocalDateTime.parse("2026-11-04T00:00:00");
        assertEquals(2, hours.countActiveDevices(from, to));
        assertEquals(1, hours.countActiveUsers(from, to));
        assertEquals(2, hours.sessions(from, to).size(), "Pings from the review account and desktop background connections are both excluded");
        assertEquals(LocalDateTime.parse("2026-11-01T10:00:00"), hours.earliestStatHour());
        var alice = users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream().filter(row -> "alice".equals(row.getUsername())).findFirst().orElseThrow();
        assertEquals(1, alice.getTerminalCount(), "shared devices remain in the ordinary user's count");
        // Read-time filtering must not erase the records used for Apple review or raw collection.
        try (var st = keepAlive.createStatement(); var rs = st.executeQuery("SELECT COUNT(*) FROM users WHERE username IN ('review_account','review_account2')")) {
            rs.next(); assertEquals(2, rs.getInt(1));
        }
        onlineInterval("mac-3", "u_a", "2026-10-01 10:00:00", "2026-10-01 10:00:00");
        session.clearCache();
        assertEquals(3, devices.countAllDevices(), "historical ordinary login retains a currently reviewing device");
        exec("DELETE FROM terminal_sessions WHERE device_uuid='mac-3' AND user_id='u_a'");
        connected("historic-normal", "mac-3", "u_b", "2026-10-01 10:00:00");
        session.clearCache();
        assertEquals(3, devices.countAllDevices(), "past normal session also retains the device");

    }

    @Test
    void userAndDeviceListsSortByLatestActivityBeforePagination() throws Exception {
        foreground("mac-1", "u_a", "2026-11-03 12:30:00");
        foreground("mac-2", "u_b", "2026-11-03 13:30:00");
        exec("INSERT INTO users (user_id, username) VALUES ('u_c', 'no-activity')");
        exec("UPDATE terminals SET last_seen_at = '2026-11-03 12:30:00' WHERE owner = 'u_a'");
        exec("UPDATE terminals SET last_seen_at = '2026-11-01 10:00:00' WHERE owner = 'u_b'");
        var users = session.getMapper(OpsUserMapper.class);
        assertEquals(List.of("u_b", "u_a", "u_c"), users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream().map(row -> row.getUserId()).toList());
        assertEquals("u_a", users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 1, 1).get(0).getUserId());
        exec("UPDATE devices SET last_active_at = '2026-11-03 14:00:00' WHERE device_uuid = 'mac-2'");
        exec("UPDATE devices SET last_active_at = NULL WHERE device_uuid = 'mac-3'");
        session.clearCache();
        var devices = session.getMapper(OpsDeviceMapper.class);
        assertEquals(List.of("mac-2", "mac-1", "mac-3"), devices.searchDevices(null, false, null, null, null, ONLINE_SINCE, 0, 20).stream().map(OpsDeviceRow::getDeviceUuid).toList());
        assertEquals("mac-1", devices.searchDevices(null, false, null, null, null, ONLINE_SINCE, 1, 1).get(0).getDeviceUuid());
        assertEquals("mac-2", devices.searchDevices(null, true, null, "u_b", null, ONLINE_SINCE, 0, 1).get(0).getDeviceUuid());
    }



    @Test
    void eachDeviceIsOneRowWithItsOwnParametersAndCountsMatchTheOverview() throws Exception {
        foreground("mac-1", "u_a", "2026-11-03 12:30:00");
        foreground("mac-2", "u_b", "2026-11-03 11:30:00");
        OpsDeviceMapper devices = session.getMapper(OpsDeviceMapper.class);

        List<OpsDeviceRow> rows = devices.searchDevices(null, false, null, null, null, ONLINE_SINCE, 0, 50);

        assertEquals(List.of("mac-1", "mac-2", "mac-3"), rows.stream().map(OpsDeviceRow::getDeviceUuid).toList(),
                "mac-1 with two linked accounts still yields one row");
        assertEquals(devices.countAllDevices(), devices.countDevices(null, false, null, null, null));
        assertEquals("两个账号的 Mac", rows.get(0).getName());
        assertEquals("0.11.0", rows.get(0).getAppVersion());
        assertNull(rows.get(1).getAppVersion(), "Empty if no version was ever reported");
        assertNull(rows.get(2).getStatus(), "Standalone has no linked account");
        assertEquals(2L, devices.countAllTerminals(), "Devices with a registered account");
        assertEquals(2L, devices.countDevices(null, true, null, null, null));
    }

    @Test
    void onlineUsersComeFirstBeforePaginationAndKeepActivityOrderWithinEachGroup() throws Exception {
        foreground("mac-1", "u_a", "2026-11-03 13:00:00");
        foreground("mac-2", "u_b", "2026-11-03 11:00:00");
        exec("INSERT INTO users (user_id, username) VALUES ('u_c', 'no-activity')");
        connected("t_b2", "mac-2", "u_b", "2026-11-03 12:00:30");
        OpsUserMapper users = session.getMapper(OpsUserMapper.class);
        assertEquals("u_b", users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 1).getFirst().getUserId());
        assertEquals("u_a", users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 1, 1).getFirst().getUserId());
        connected("t_a1", "mac-1", "u_a", "2026-11-03 12:00:30");
        session.clearCache();
        assertEquals(List.of("u_a", "u_b", "u_c"), users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE,
                0, 20).stream().map(row -> row.getUserId()).toList());
        exec("UPDATE terminal_sessions SET last_seen_at='2026-11-03 11:00:00' WHERE terminal_id='t_a1'");
        session.clearCache();
        assertEquals(List.of("u_b", "u_a", "u_c"), users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE,
                0, 20).stream().map(row -> row.getUserId()).toList());
    }

    @Test
    void onlineDevicesComeFirstBeforePaginationAndKeepActivityOrderWithinEachGroup() throws Exception {
        foreground("mac-1", "u_a", "2026-11-03 13:00:00");
        foreground("mac-2", "u_b", "2026-11-03 11:00:00");
        connected("t_b2", "mac-2", "u_b", "2026-11-03 12:00:30");
        OpsDeviceMapper devices = session.getMapper(OpsDeviceMapper.class);
        for (boolean registeredOnly : List.of(false, true)) {
            assertEquals("mac-2", devices.searchDevices(null, registeredOnly, null, null, null,
                    ONLINE_SINCE, 0, 1).getFirst().getDeviceUuid());
            assertEquals("mac-1", devices.searchDevices(null, registeredOnly, null, null, null,
                    ONLINE_SINCE, 1, 1).getFirst().getDeviceUuid());
        }
        connected("t_a1", "mac-1", "u_a", "2026-11-03 12:00:30");
        session.clearCache();
        assertEquals(List.of("mac-1", "mac-2", "mac-3"), devices.searchDevices(null, false, null,
                null, null, ONLINE_SINCE, 0, 20).stream().map(OpsDeviceRow::getDeviceUuid).toList());
        exec("UPDATE terminals SET status='DISABLED' WHERE fingerprint='mac-1'");
        session.clearCache();
        assertEquals(List.of("mac-2", "mac-1", "mac-3"), devices.searchDevices(null, false, null,
                null, null, ONLINE_SINCE, 0, 20).stream().map(OpsDeviceRow::getDeviceUuid).toList());
    }

    @Test
    void linkedAccountsAreAllListedAndOnlineComesFromOpenSessions() throws Exception {
        connected("t_b1", "mac-1", "u_b", "2026-11-03 12:00:30");
        OpsDeviceMapper devices = session.getMapper(OpsDeviceMapper.class);

        Map<String, OpsDeviceAccountRow> accounts = devices.accountsOf(List.of("mac-1"), ONLINE_SINCE).stream()
                .collect(Collectors.toMap(OpsDeviceAccountRow::getUsername, Function.identity()));

        assertEquals(2, accounts.size());
        assertEquals(true, accounts.get("bob").isOnline());
        assertEquals(false, accounts.get("alice").isOnline());
        assertEquals("ONLINE", listed(false, null, null).get("mac-1").getStatus());
        assertEquals("OFFLINE", listed(false, null, null).get("mac-2").getStatus(), "The status column says ONLINE, but there is no connection");
        assertEquals(1L, devices.countOnlineTerminals(ONLINE_SINCE));
    }

    @Test
    void onlineListMatchesOverviewAndExcludesStaleDisabledAndStandaloneDevices() throws Exception {
        connected("t_b1", "mac-1", "u_b", "2026-11-03 12:00:30");
        connected("t_a1", "mac-1", "u_a", "2026-11-03 12:00:30");
        connected("t_b2", "mac-2", "u_b", "2026-11-03 11:00:00");
        OpsDeviceMapper devices = session.getMapper(OpsDeviceMapper.class);
        assertEquals(1L, devices.countDevices(null, false, ONLINE_SINCE, null, null));
        assertEquals(devices.countOnlineTerminals(ONLINE_SINCE), devices.countDevices(null, false, ONLINE_SINCE, null, null));
        assertEquals(List.of("mac-1"), devices.searchDevices(null, false, ONLINE_SINCE, null, null, ONLINE_SINCE, 0, 20).stream().map(OpsDeviceRow::getDeviceUuid).toList());
        exec("UPDATE terminals SET status = 'DISABLED' WHERE fingerprint = 'mac-1'");
        session.clearCache();
        assertEquals(0L, devices.countDevices(null, false, ONLINE_SINCE, null, null));
    }

    @Test
    void aSessionNobodyHasObservedLatelyIsNotOnline() throws Exception {
        connected("t_b1", "mac-1", "u_b", "2026-11-03 11:00:00");
        assertEquals("OFFLINE", listed(false, null, null).get("mac-1").getStatus());
        assertEquals(0L, session.getMapper(OpsDeviceMapper.class).countOnlineTerminals(ONLINE_SINCE));
    }

    @Test
    void ownerFiltersMatchTheTwoCountsInTheUserList() throws Exception {
        foreground("mac-1", "u_b", "2026-11-03 10:00:00");
        foreground("mac-2", "u_b", "2026-09-01 10:00:00");
        exec("UPDATE terminals SET last_seen_at = '2026-11-03 10:00:00' WHERE terminal_id = 't_b1'");
        exec("UPDATE terminals SET last_seen_at = '2026-09-01 10:00:00' WHERE terminal_id = 't_b2'");
        OpsDeviceMapper devices = session.getMapper(OpsDeviceMapper.class);

        var bob = session.getMapper(OpsUserMapper.class).searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream()
                .filter(row -> "bob".equals(row.getUsername())).findFirst().orElseThrow();
        assertEquals(2, bob.getTerminalCount());
        assertEquals(1, bob.getActiveTerminalCount(), "mac-2 is outside the 30-day window");
        assertEquals(2L, devices.countDevices(null, true, null, "u_b", null), "Clicking the registered count gives the same number of rows");
        assertEquals(1L, devices.countDevices(null, true, null, "u_b", ACTIVE_SINCE), "Clicking the active count gives the same number of rows");
        assertEquals(java.util.Set.of("mac-1"), listed(true, "u_b", ACTIVE_SINCE).keySet());
        assertEquals(1L, devices.countDevices(null, true, null, "u_a", null), "The same mac-1 also counts for alice");
    }

    @Test
    void onlineCountsForTheConnectedAccountOnly() throws Exception {
        foreground("mac-1", "u_a", "2026-11-01 09:30:00");
        OpsDeviceMapper devices = session.getMapper(OpsDeviceMapper.class);

        var rows = session.getMapper(OpsUserMapper.class).searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream()
                .collect(Collectors.toMap(row -> row.getUsername(), Function.identity()));

        assertEquals(1, rows.get("alice").getActiveTerminalCount());
        assertEquals(LocalDateTime.parse("2026-11-01T09:30:00"), rows.get("alice").getLastActiveAt());
        assertEquals(1L, devices.countDevices(null, true, null, "u_a", ACTIVE_SINCE));
        assertEquals(0, rows.get("bob").getActiveTerminalCount(), "bob was never active on the same desktop");
        assertEquals(0L, devices.countDevices(null, true, null, "u_b", ACTIVE_SINCE));
    }

    @Test
    void lastActiveIsEmptyWithoutAnyRecordAndTheTelemetryOwnerIsNotUsed() throws Exception {
        // device_telemetry's user_id is just the last reporting account, which doesn't make alice active
        exec("INSERT INTO device_telemetry (device_uuid, user_id, agents) VALUES ('mac-1', 'u_a', 'codex')");
        var rows = session.getMapper(OpsUserMapper.class).searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream()
                .collect(Collectors.toMap(row -> row.getUsername(), Function.identity()));
        assertNull(rows.get("alice").getLastActiveAt());
        assertNull(rows.get("bob").getLastActiveAt());
        assertEquals(false, rows.get("alice").isOnline());

        connected("t_b1", "mac-1", "u_b", "2026-11-03 12:00:20");
        exec("UPDATE terminals SET last_seen_at = '2026-11-03 12:00:20' WHERE terminal_id = 't_b1'");
        session.clearCache();
        var bob = session.getMapper(OpsUserMapper.class).searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream()
                .filter(row -> "bob".equals(row.getUsername())).findFirst().orElseThrow();
        assertNull(bob.getLastActiveAt(), "Connected to the cloud but never opened the UI: not active");
        assertEquals(true, bob.isOnline());

        foreground("mac-1", "u_b", "2026-11-03 12:10:00");
        session.clearCache();
        bob = session.getMapper(OpsUserMapper.class).searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream()
                .filter(row -> "bob".equals(row.getUsername())).findFirst().orElseThrow();
        assertEquals(LocalDateTime.parse("2026-11-03T12:10:00"), bob.getLastActiveAt(), "Only counts once the window was in the foreground");
    }

    @Test
    void phoneSessionsOverlappingAWindowCountEvenIfTheyStartedBeforeIt() throws Exception {
        // Mobiles only connect in the foreground, so the connection interval is the active interval
        exec("INSERT INTO terminals (terminal_id, name, status, owner, fingerprint, type) VALUES ('t_m', 'Alice 的手机', 'ONLINE', 'u_a', 'phone-1', 'MOBILE')");
        exec("INSERT INTO terminal_sessions (terminal_id, device_uuid, user_id, online_at, offline_at, last_seen_at) VALUES "
                + "('t_m', 'phone-1', 'u_a', '2026-11-01 23:59:45', '2026-11-02 00:00:15', '2026-11-02 00:00:15')");
        // The desktop was also connected at the same time, but its window was never in the foreground
        exec("INSERT INTO terminal_sessions (terminal_id, device_uuid, user_id, online_at, offline_at, last_seen_at) VALUES "
                + "('t_a1', 'mac-1', 'u_a', '2026-11-01 23:00:00', '2026-11-03 01:00:00', '2026-11-03 01:00:00')");
        ActivityMapper hours = session.getMapper(ActivityMapper.class);
        var day1 = LocalDateTime.parse("2026-11-01T00:00:00");
        var day2 = day1.plusDays(1);

        assertEquals(1L, hours.countActiveDevices(day1, day2));
        assertEquals(1L, hours.countActiveDevices(day2, day2.plusDays(1)), "Overnight counts as two days");
        assertEquals(1L, hours.countActiveUsers(day2, day2.plusDays(1)));
        assertEquals(0L, hours.countActiveDevices(day2.plusDays(1), day2.plusDays(2)));
        var row = hours.sessions(day2, day2.plusDays(1)).get(0);
        assertEquals(LocalDateTime.parse("2026-11-02T00:00:15"), row.getEndedAt());
    }

    @Test
    void backgroundConnectionsAreNotActivityAndLostConnectionsStopAtLastObservation() throws Exception {
        connected("t_a1", "mac-1", "u_a", "2026-11-03 23:59:00");
        exec("UPDATE terminal_sessions SET online_at='2026-11-03 23:00:00' WHERE terminal_id='t_a1'");
        var hours = session.getMapper(ActivityMapper.class);
        var day = LocalDateTime.parse("2026-11-04T00:00:00");
        assertEquals(0, hours.countActiveDevices(day.minusDays(1), day), "Connected to the cloud but window never in the foreground: not active");
        assertEquals(0, hours.sessions(day.minusDays(1), day).size());
        assertEquals(0, hours.desktopConnections(day, day.plusDays(1)).size(), "A connection with no observed disconnect stops at the last observation and doesn't extend into the next day");
        var rows = hours.desktopConnections(day.minusDays(1), day);
        assertEquals(1, rows.size());
        assertEquals(LocalDateTime.parse("2026-11-03T23:59:00"), rows.getFirst().getEndedAt());

        foreground("mac-1", "u_a", "2026-11-03 23:10:00");
        session.clearCache();
        assertEquals(1, hours.countActiveDevices(day.minusDays(1), day));
        assertEquals(1, hours.countActiveUsers(day.minusDays(1), day));
        assertEquals(0, hours.countActiveDevices(day, day.plusDays(1)), "A foreground ping is an instant and doesn't span days");
    }

    @Test
    void agentCountIsWhatTheFriendListShowsNotEverythingDiscovered() throws Exception {
        exec("INSERT INTO users (user_id, username, display_name, is_agent, owner, status) VALUES "
                + "('ag_1', 'ag1', '已加', 1, 'u_a', 'ACTIVE'), ('ag_2', 'ag2', '只发现', 1, 'u_a', 'ACTIVE'),"
                + "('ag_3', 'ag3', '共享来的', 1, 'u_b', 'ACTIVE')");
        exec("INSERT INTO users_rel (user_id, friend_id, status) VALUES ('u_a', 'ag_1', 'ACCEPTED'), ('u_a', 'ag_3', 'SHARED')");
        OpsUserMapper users = session.getMapper(OpsUserMapper.class);

        var alice = users.searchUsers(null, ACTIVE_SINCE, ONLINE_SINCE, 0, 20).stream()
                .filter(row -> "alice".equals(row.getUsername())).findFirst().orElseThrow();

        assertEquals(1, alice.getAgentCount(), "Discovered but not added as a contact doesn't count, nor do ones shared by others");
        assertEquals(1L, users.countAgentRows(null, "u_a", true), "The list opened by clicking matches the number");
        var listed = users.searchAgents(null, "u_a", true, 0, 20);
        assertEquals(List.of("ag_1"), listed.stream().map(row -> row.getUserId()).toList());
        assertEquals(true, listed.get(0).isContact());
        assertEquals(2L, users.countAgentRows(null, "u_a", false), "Without the contact filter, all discovered ones are visible");
    }


}
