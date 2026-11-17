package com.politeness.ading.ops.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.dal.mapper.*;
import java.time.*;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.mybatis.spring.transaction.SpringManagedTransactionFactory;
import org.springframework.jdbc.core.JdbcTemplate;

class ActiveMembersTest {
    @Test void drilldownUsesHistoricalBucketsDeduplicatesAndPaginates() {
        var source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:active-members;MODE=MySQL;DB_CLOSE_DELAY=-1");
        var db = new JdbcTemplate(source);
        try {
            db.execute("CREATE TABLE users(user_id VARCHAR(64),is_agent INT,username VARCHAR(64),display_name VARCHAR(64),terminal_id VARCHAR(64),agent_type VARCHAR(32),readiness VARCHAR(32),status VARCHAR(16),owner VARCHAR(64))");
            db.execute("CREATE TABLE devices(device_uuid VARCHAR(64), name VARCHAR(64), device_type VARCHAR(16), os_version VARCHAR(64), app_version VARCHAR(32), city VARCHAR(64), agents VARCHAR(255), first_seen_at TIMESTAMP, last_active_at TIMESTAMP)");
            db.execute("CREATE TABLE terminal_sessions(terminal_id VARCHAR(64),device_uuid VARCHAR(64),user_id VARCHAR(64),online_at TIMESTAMP,offline_at TIMESTAMP,last_seen_at TIMESTAMP, open_terminal_id VARCHAR(64))");
            db.execute("CREATE TABLE terminals(id BIGINT, terminal_id VARCHAR(64), fingerprint VARCHAR(64), owner VARCHAR(64), status VARCHAR(16), last_seen_at TIMESTAMP, type VARCHAR(32) DEFAULT 'DESKTOP')");
            db.execute("CREATE TABLE device_telemetry(device_uuid VARCHAR(128),user_id VARCHAR(64),agents VARCHAR(255))");
            db.execute("CREATE TABLE device_telemetry_hour(stat_hour TIMESTAMP,device_uuid VARCHAR(128),user_id VARCHAR(64),device_type VARCHAR(16),reported_at TIMESTAMP)");
            db.update("INSERT INTO users(user_id,is_agent,username,display_name) VALUES ('p1',0,'person1','用户一'),('p2',0,'person2','用户二'),('agent',1,'robot','机器人')");
            db.update("INSERT INTO devices(device_uuid,name,device_type) VALUES ('mac','电脑','mac'),('both','两个账号的电脑','mac')");
            // Desktop foreground pings: one row per hour
            String report = "INSERT INTO device_telemetry_hour(stat_hour,device_uuid,user_id,device_type,reported_at) VALUES (?,?,?,'mac',?)";
            db.update(report,"2026-11-01 08:00:00","mac","p1","2026-11-01 08:30:00");
            db.update(report,"2026-11-01 09:00:00","mac","p1","2026-11-01 09:30:00");
            db.update(report,"2026-11-01 09:00:00","deleted-terminal","p2","2026-11-01 09:20:00");
            db.update(report,"2026-11-01 09:00:00","standalone",null,"2026-11-01 09:00:00");
            db.update(report,"2026-11-02 00:00:00","tomorrow","p2","2026-11-02 00:00:00");
            db.update(report,"2026-11-01 10:00:00","both","p1","2026-11-01 10:05:00");
            db.update(report,"2026-11-01 10:00:00","both","p2","2026-11-01 10:40:00");
            String open = "INSERT INTO terminal_sessions(terminal_id,device_uuid,user_id,online_at,offline_at,last_seen_at) VALUES (?,?,?,?,?,?)";
            // A mobile's connection is itself activity
            db.update(open,"tm","phone","p1","2026-11-01 09:10:00","2026-11-01 09:10:00","2026-11-01 09:10:00");
            // Desktop connections only count toward duration for desktops that were active
            db.update(open,"t1","both","p1","2026-11-01 10:00:00","2026-11-01 11:00:00","2026-11-01 11:00:00");
            db.update(open,"t2","both","p2","2026-11-01 10:30:00",null,"2026-11-01 12:00:00");
            // p2's other desktop was connected all morning but never opened the UI: not active and no duration
            db.update(open,"t4","background","p2","2026-11-01 08:00:00","2026-11-01 12:00:00","2026-11-01 12:00:00");
            db.update("UPDATE devices SET app_version='0.11.0',city='杭州',agents='codex,qoder',os_version='macOS 26',first_seen_at='2026-10-01 09:00:00',last_active_at='2026-11-02 09:00:00' WHERE device_uuid='both'");
            db.update("INSERT INTO terminals VALUES(1,'t1','both','p1','ACTIVE','2026-11-01 11:00:00','DESKTOP'),(2,'t2','both','p2','ACTIVE','2026-11-01 12:00:00','DESKTOP'),(3,'tm','phone','p1','ACTIVE','2026-11-01 09:10:00','MOBILE'),(4,'t4','background','p2','ACTIVE','2026-11-01 12:00:00','DESKTOP')");
            db.update("INSERT INTO users(user_id,is_agent,terminal_id,agent_type,readiness,status) VALUES ('ag1',1,'t1','codex','ready','ACTIVE'),('ag2',1,'t1','qoder','ready','ACTIVE')");
            var config = new Configuration(new Environment("test",new SpringManagedTransactionFactory(),source));
            config.setMapUnderscoreToCamelCase(true);com.politeness.ading.ops.dal.mapper.StatisticsExclusions.apply(config, "");config.addMapper(ActiveMemberMapper.class);config.addMapper(OpsDeviceMapper.class);config.addMapper(ActivityMapper.class);
            var template = new SqlSessionTemplate(new SqlSessionFactoryBuilder().build(config));
            var hours = template.getMapper(ActivityMapper.class);
            var service = new OpsStatsService(mock(OpsUserMapper.class),template.getMapper(OpsDeviceMapper.class),hours,
                    Clock.fixed(Instant.parse("2026-11-01T10:30:00Z"),ZoneId.of("Asia/Shanghai")),template.getMapper(ActiveMemberMapper.class));
            var from = LocalDateTime.parse("2026-11-01T00:00:00");var to = from.plusDays(1);
            assertEquals(5,hours.countActiveDevices(from,to),"Four desktops that were in the foreground plus one mobile; the one only connected in the background doesn't count");
            assertEquals(2,hours.countActiveUsers(from,to));
            var terminals = service.activeMembers("terminals","today","","day","all",1,20).members();
            assertEquals(5,terminals.total());
            var both = terminals.items().getFirst();
            assertEquals("both",both.memberId(),"Most recently active first");
            assertEquals("两个账号的电脑",both.name());
            assertEquals("person1、person2",both.username(),"One device can count toward several accounts at once");
            assertEquals(2.0,both.activeHours(),0.001,"10:00-12:00, overlaps not double-counted, still-open ones count up to the last observation");
            assertEquals(LocalDateTime.parse("2026-11-01T10:40:00"),both.lastActiveAt(),"Latest activity is the last foreground ping, not the connection");
            assertEquals("both",both.device().deviceUuid());
            assertEquals("0.11.0",both.device().appVersion());
            assertEquals("杭州",both.device().city());
            assertEquals(java.util.List.of("codex","qoder"),both.device().agents());
            assertEquals(2,both.device().accounts().size());
            assertEquals("OFFLINE",both.device().status());
            assertEquals(LocalDateTime.parse("2026-10-01T09:00:00"),both.device().firstSeenAt());
            assertEquals(both.lastActiveAt(),both.device().lastActiveAt(),"Latest activity in the device details matches the activity details");
            assertNull(terminals.items().stream().filter(m -> m.memberId().equals("deleted-terminal")).findFirst().orElseThrow().device());
            var users = service.activeMembers("users","today","","day","all",1,20).members();
            assertEquals(2,users.total());
            var p2 = users.items().getFirst();
            assertEquals("p2",p2.memberId());assertEquals("person2",p2.username());
            assertEquals(1.5,p2.activeHours(),0.001,"The desktop that never opened the UI gets no duration");
            assertEquals(2,p2.terminalCount());
            var p1 = users.items().get(1);
            assertEquals(3,p1.terminalCount());assertEquals(1.0,p1.activeHours(),0.001,"Pings are instants and don't count toward duration");
            assertEquals(1,service.activeMembers("users","today","","day","all",2,1).members().items().size());
            assertEquals(4,service.activeMembers("terminals","today","","day","loggedIn",1,20).members().total());
            assertEquals("standalone",service.activeMembers("terminals","today","","day","standalone",1,20).members().items().getFirst().memberId());
            assertEquals(1,service.activeMembers("terminals","bucket","2026-11-01T08:00:00","hour","all",1,20).members().total());
            assertEquals(0,service.activeMembers("users","yesterday","","day","all",1,20).members().total());
        } finally { db.execute("DROP ALL OBJECTS"); }
    }

    @Test void rangesUseServerCalendarAndRejectInvalidQueries() {
        var mapper = mock(ActiveMemberMapper.class);
        var service = new OpsStatsService(mock(OpsUserMapper.class),mock(OpsDeviceMapper.class),mock(ActivityMapper.class),
                Clock.fixed(Instant.parse("2026-11-01T10:30:00Z"),ZoneId.of("Asia/Shanghai")), mapper);
        var today = LocalDateTime.parse("2026-11-01T00:00:00");
        assertEquals(today,service.activeMembers("terminals","today","","day","all",1,20).from());
        assertEquals(today.minusDays(1),service.activeMembers("users","yesterday","","day","all",1,20).from());
        assertEquals(today.minusDays(29),service.activeMembers("users","last30","","day","all",1,20).from());
        assertEquals(today,service.activeMembers("users","month","","day","all",1,20).from());
        var hour=service.activeMembers("terminals","bucket","2026-11-01T08:00:00","hour","loggedIn",1,20);
        assertEquals(today.plusHours(8),hour.from());assertEquals(today.plusHours(9),hour.to());
        assertThrows(BizException.class,()->service.activeMembers("bad","today","","day","all",1,20));
        assertThrows(BizException.class,()->service.activeMembers("users","today","","day","standalone",1,20));
        for(String bucket:new String[]{"bad","2026-11-02T00:00:00","2026-11-01T08:15:00","2026-01-01T00:00:00"})
            assertThrows(BizException.class,()->service.activeMembers("terminals","bucket",bucket,"hour","all",1,20));
        assertThrows(BizException.class,()->service.activeMembers("users","today","","day","all",0,20));
    }
}
