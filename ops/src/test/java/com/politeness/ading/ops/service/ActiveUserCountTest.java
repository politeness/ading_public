package com.politeness.ading.ops.service;
import static org.junit.jupiter.api.Assertions.*;
import com.politeness.ading.ops.dal.mapper.ActivityMapper;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.mybatis.spring.transaction.SpringManagedTransactionFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import java.time.LocalDateTime;
class ActiveUserCountTest {
    @Test void multipleDevicesAndRepeatedHoursCountEachPersonOnlyOnce() {
        var source=new JdbcDataSource();source.setURL("jdbc:h2:mem:active-users;MODE=MySQL;DB_CLOSE_DELAY=-1");
        var db=new JdbcTemplate(source);
        try {
            db.execute("CREATE TABLE devices(device_uuid VARCHAR(128),device_type VARCHAR(16))");
            db.execute("CREATE TABLE users(user_id VARCHAR(64),is_agent INT,username VARCHAR(64))");
            db.execute("CREATE TABLE terminals(terminal_id VARCHAR(64),type VARCHAR(32),fingerprint VARCHAR(128),owner VARCHAR(64))");
            db.execute("CREATE TABLE terminal_sessions(terminal_id VARCHAR(64),device_uuid VARCHAR(64),user_id VARCHAR(64),online_at TIMESTAMP,offline_at TIMESTAMP,last_seen_at TIMESTAMP)");
            db.execute("CREATE TABLE device_telemetry_hour(stat_hour TIMESTAMP,device_uuid VARCHAR(128),user_id VARCHAR(64),device_type VARCHAR(16),reported_at TIMESTAMP)");
            db.update("INSERT INTO users(user_id,is_agent) VALUES ('person1',0),('person2',0)");
            db.update("INSERT INTO users(user_id,is_agent) VALUES ('person3',0)");
            db.update("INSERT INTO terminals(terminal_id,type,fingerprint,owner) VALUES ('tm','MOBILE','phone1','person1'),('td','DESKTOP','background','person3')");
            // Desktops use foreground pings: the same desktop across two hours, or one person with two devices, counts once
            db.update("INSERT INTO device_telemetry_hour(stat_hour,device_uuid,user_id,device_type,reported_at) VALUES ('2026-11-01 08:00:00','mac1','person1','mac','2026-11-01 08:10:00'),('2026-11-01 09:00:00','mac1','person1','mac','2026-11-01 09:10:00'),('2026-11-01 09:00:00','mac2','person2','mac','2026-11-01 09:00:00'),('2026-11-01 09:00:00','standalone',NULL,'mac','2026-11-01 09:00:00')");
            // Mobiles use connections; person3's desktop was connected to the cloud all day but never opened the UI, so not active
            db.update("INSERT INTO terminal_sessions(terminal_id,device_uuid,user_id,online_at,offline_at,last_seen_at) VALUES ('tm','phone1','person1','2026-11-01 09:00:00','2026-11-01 09:05:00','2026-11-01 09:05:00'),('td','background','person3','2026-11-01 00:00:00',NULL,'2026-11-01 23:59:00')");
            var config=new Configuration(new Environment("test",new SpringManagedTransactionFactory(),source));com.politeness.ading.ops.dal.mapper.StatisticsExclusions.apply(config, "");config.addMapper(ActivityMapper.class);
            var mapper=new SqlSessionTemplate(new SqlSessionFactoryBuilder().build(config)).getMapper(ActivityMapper.class);
            var from=LocalDateTime.parse("2026-11-01T00:00:00");var to=from.plusDays(1);
            assertEquals(4,mapper.countActiveDevices(from,to));
            assertEquals(2,mapper.countActiveUsers(from,to));
            assertEquals(0,mapper.countActiveUsers(to,to.plusDays(1)));
        } finally {db.execute("DROP ALL OBJECTS");}
    }
}
