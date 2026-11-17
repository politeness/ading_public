package com.politeness.ading.conductor.mqtt;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.mapper.DeviceMapper;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.dal.mapper.TerminalSessionMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.Set;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Runs real SQL (H2 MySQL mode): two tracker instances simulate the pre-release and production processes sharing one table, each without in-memory state. */
class TerminalSessionTrackerTest {
    private static final LocalDateTime T0 = LocalDateTime.parse("2026-11-03T10:00:00");

    private Connection keepAlive;
    private SqlSession session;
    private TerminalSessionTracker pre;
    private TerminalSessionTracker prod;
    private DeviceMapper devices;
    private final TerminalEntity terminal = new TerminalEntity();

    @BeforeEach void setUp() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:sessions_" + System.nanoTime() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        keepAlive = dataSource.getConnection();
        try (Statement st = keepAlive.createStatement()) {
            st.execute("""
                    CREATE TABLE terminal_sessions (id BIGINT AUTO_INCREMENT PRIMARY KEY, terminal_id VARCHAR(64) NOT NULL,
                      device_uuid VARCHAR(128) NOT NULL, user_id VARCHAR(64) NOT NULL, online_at DATETIME NOT NULL,
                      offline_at DATETIME, last_seen_at DATETIME NOT NULL, open_terminal_id VARCHAR(64), UNIQUE (open_terminal_id))""");
            st.execute("""
                    CREATE TABLE devices (id BIGINT AUTO_INCREMENT PRIMARY KEY, gmt_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
                      device_uuid VARCHAR(128) NOT NULL UNIQUE, device_type VARCHAR(16) NOT NULL, name VARCHAR(100), os_version VARCHAR(64),
                      app_version VARCHAR(50), city VARCHAR(64), agents VARCHAR(255), first_seen_at DATETIME, last_active_at DATETIME)""");
            st.execute("""
                    CREATE TABLE terminals (id BIGINT AUTO_INCREMENT PRIMARY KEY, gmt_modified DATETIME DEFAULT CURRENT_TIMESTAMP,
                      terminal_id VARCHAR(64), last_seen_at DATETIME)""");
            st.execute("INSERT INTO terminals (terminal_id) VALUES ('t1')");
        }
        Configuration configuration = new Configuration(new Environment("test", new JdbcTransactionFactory(), dataSource));
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(TerminalSessionMapper.class);
        configuration.addMapper(DeviceMapper.class);
        configuration.addMapper(TerminalMapper.class);
        session = new SqlSessionFactoryBuilder().build(configuration).openSession(true);
        devices = session.getMapper(DeviceMapper.class);
        pre = new TerminalSessionTracker(session.getMapper(TerminalSessionMapper.class), devices, session.getMapper(TerminalMapper.class));
        prod = new TerminalSessionTracker(session.getMapper(TerminalSessionMapper.class), devices, session.getMapper(TerminalMapper.class));
        terminal.setTerminalId("t1");
        terminal.setFingerprint("uuid-1");
        terminal.setOwner("u1");
        terminal.setName("旧版后端注册的电脑");
    }

    @AfterEach void tearDown() throws Exception {
        session.close();
        keepAlive.close();
    }

    private void observeOnline(TerminalSessionTracker tracker, LocalDateTime at) {
        tracker.online(terminal, tracker.begin(), at);
    }

    private int rows() throws Exception {
        try (Statement st = keepAlive.createStatement(); ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM terminal_sessions")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private LocalDateTime column(String sql) throws Exception {
        try (Statement st = keepAlive.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getObject(1, LocalDateTime.class);
        }
    }

    @Test void twoProcessesObservingTheSameConnectionKeepOneSession() throws Exception {
        // Both sides read "no open session" at the same time and both open one: the unique key merges them into one row
        var preView = pre.begin();
        var prodView = prod.begin();
        pre.online(terminal, preView, T0);
        prod.online(terminal, prodView, T0.plusSeconds(3));
        assertEquals(1, rows());
        assertEquals(T0, column("SELECT online_at FROM terminal_sessions"));
        assertEquals(T0.plusSeconds(3), column("SELECT last_seen_at FROM terminal_sessions"));
        assertEquals("旧版后端注册的电脑", devices.findName("uuid-1"), "Terminal registered by the old backend gets its device row filled in during polling");
    }

    @Test void lastSeenIsThrottledThenAdvancesAndAlsoReachesDeviceAndTerminal() throws Exception {
        observeOnline(pre, T0);
        observeOnline(prod, T0.plusSeconds(10));
        assertEquals(T0, column("SELECT last_seen_at FROM terminal_sessions"), "Neither process writes again within 30 seconds");
        observeOnline(prod, T0.plusSeconds(31));
        assertEquals(T0.plusSeconds(31), column("SELECT last_seen_at FROM terminal_sessions"));
        assertEquals(T0.plusSeconds(31), column("SELECT last_seen_at FROM terminals"));
        assertEquals(T0.plusSeconds(31), column("SELECT last_active_at FROM devices"));
    }

    @Test void disconnectSeenLiveEndsAtTheObservationAndResidualEndsAtLastSeen() throws Exception {
        observeOnline(pre, T0);
        pre.offline(terminal, true, pre.begin(), T0.plusSeconds(40));
        assertEquals(T0.plusSeconds(40), column("SELECT offline_at FROM terminal_sessions"), "Disconnect observed directly");

        // New connection; the disconnect is only found after a process restart: the time is unknown, so count only up to the last observation
        observeOnline(pre, T0.plusMinutes(10));
        prod.offline(terminal, false, prod.begin(), T0.plusMinutes(12));
        assertEquals(T0.plusMinutes(10), column("SELECT offline_at FROM terminal_sessions ORDER BY id DESC LIMIT 1"));
        assertEquals(2, rows());
        assertTrue(pre.begin().isEmpty(), "All closed");
    }

    @Test void bothProcessesSeeingTheDisconnectCloseOnce() throws Exception {
        observeOnline(pre, T0);
        var preView = pre.begin();
        var prodView = prod.begin();
        pre.offline(terminal, true, preView, T0.plusSeconds(20));
        prod.offline(terminal, true, prodView, T0.plusSeconds(25));
        assertEquals(1, rows());
        assertEquals(T0.plusSeconds(20), column("SELECT offline_at FROM terminal_sessions"), "Second time does not overwrite the offline time");
    }

    @Test void aStaleOfflineObservationDoesNotCloseWhatTheOtherProcessJustSawConnected() throws Exception {
        observeOnline(pre, T0);
        observeOnline(prod, T0.plusSeconds(60));
        pre.offline(terminal, true, pre.begin(), T0.plusSeconds(50));
        assertFalse(pre.begin().isEmpty(), "This observation is earlier than the connection recorded by the other side, so it has reconnected");
        assertNull(column("SELECT offline_at FROM terminal_sessions"));
    }

    @Test void aGapWithNoObserverSplitsTheSessionInsteadOfCountingTheUnknownTime() throws Exception {
        observeOnline(pre, T0);
        observeOnline(pre, T0.plusHours(3));
        assertEquals(2, rows());
        assertEquals(T0, column("SELECT offline_at FROM terminal_sessions ORDER BY id LIMIT 1"), "The three hours with the whole backend stopped do not count");
        assertEquals(T0.plusHours(3), column("SELECT online_at FROM terminal_sessions ORDER BY id DESC LIMIT 1"));
    }

    @Test void terminalsNoLongerPolledAreClosedAndPolledOnesAreLeftAlone() throws Exception {
        observeOnline(pre, T0);
        pre.finish(pre.begin(), Set.of("t1"), T0.plusSeconds(15));
        assertFalse(pre.begin().isEmpty(), "Already-checked ones are untouched, including those whose query failed this round");
        pre.finish(pre.begin(), Set.of(), T0.plusSeconds(30));
        assertTrue(pre.begin().isEmpty());
        assertEquals(T0, column("SELECT offline_at FROM terminal_sessions"));
    }

    @Test void deviceParametersAreSharedAndOldClientsDoNotEraseThem() throws Exception {
        devices.upsertRegistered("uuid-2", "desktop", "新名字", "0.12.0", "macOS 26.1", T0);
        devices.upsertRegistered("uuid-2", "desktop", null, null, null, T0.plusSeconds(5));
        devices.updateCity("uuid-2", "上海市");
        assertEquals("新名字", devices.findName("uuid-2"));
        assertEquals(1, devices.updateAppVersion("uuid-2", "0.12.1"));
        assertEquals(0, devices.updateAppVersion("never-seen", "0.12.1"), "An anonymous update check must not create a device out of nothing");
        try (Statement st = keepAlive.createStatement();
             ResultSet rs = st.executeQuery("SELECT device_type, app_version, os_version, city, agents, first_seen_at, last_active_at FROM devices WHERE device_uuid = 'uuid-2'")) {
            rs.next();
            assertEquals("desktop", rs.getString(1));
            assertEquals("0.12.1", rs.getString(2));
            assertEquals("macOS 26.1", rs.getString(3), "Not cleared when an old client does not send the OS version");
            assertEquals("上海市", rs.getString(4));
            assertNull(rs.getString(5));
            assertEquals(T0, rs.getObject(6, LocalDateTime.class));
            assertEquals(T0.plusSeconds(5), rs.getObject(7, LocalDateTime.class));
        }
    }

    @Test void migrationScriptsDoNotEstimateAndKeepTheLegacyDrops() throws Exception {
        String lastSeen = Files.readString(Path.of("docs/alter-2026-11-03-terminal-last-seen.sql"));
        assertFalse(lastSeen.contains("UPDATE terminals"), "The user does not accept estimated backfill");
        String legacy = Files.readString(Path.of("docs/alter-2026-11-03-drop-legacy-tables.sql"));
        assertTrue(legacy.contains("DROP TABLE IF EXISTS `node_events`"));
        assertTrue(legacy.contains("DROP TABLE IF EXISTS `node_leases`"));
        String create = Files.readString(Path.of("docs/create-database.sql"));
        assertTrue(create.contains("CREATE TABLE `devices`"));
        assertTrue(create.contains("CREATE TABLE `terminal_sessions`"));
    }
}
