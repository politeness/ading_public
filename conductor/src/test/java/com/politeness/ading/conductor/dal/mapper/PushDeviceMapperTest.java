package com.politeness.ading.conductor.dal.mapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.util.List;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class PushDeviceMapperTest {
    private Connection keepAlive;
    private SqlSession session;
    private PushDeviceMapper mapper;

    @BeforeEach void setUp() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:push_devices_" + System.nanoTime() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        keepAlive = dataSource.getConnection();
        try (Statement st = keepAlive.createStatement()) {
            st.execute("""
                    CREATE TABLE push_devices (id BIGINT AUTO_INCREMENT PRIMARY KEY, terminal_id VARCHAR(64) UNIQUE, owner VARCHAR(64),
                      device_token VARCHAR(200) UNIQUE, environment VARCHAR(16), language VARCHAR(8))""");
            st.execute("CREATE TABLE terminals (id BIGINT AUTO_INCREMENT PRIMARY KEY, terminal_id VARCHAR(64), status VARCHAR(32))");
            st.execute("INSERT INTO terminals (terminal_id, status) VALUES ('t1', 'OFFLINE'), ('t2', 'OFFLINE'), ('t3', 'DISABLED')");
        }
        Configuration configuration = new Configuration(new Environment("test", new JdbcTransactionFactory(), dataSource));
        configuration.setMapUnderscoreToCamelCase(true);
        configuration.addMapper(PushDeviceMapper.class);
        session = new SqlSessionFactoryBuilder().build(configuration).openSession(true);
        mapper = session.getMapper(PushDeviceMapper.class);
    }

    @AfterEach void tearDown() throws Exception {
        session.close();
        keepAlive.close();
    }

    private static PushDeviceEntity device(String terminal, String owner, String token) {
        PushDeviceEntity device = new PushDeviceEntity();
        device.setTerminalId(terminal);
        device.setOwner(owner);
        device.setDeviceToken(token);
        device.setEnvironment("production");
        device.setLanguage("zh");
        return device;
    }

    @Test void reRegisteringUpdatesTheSameRow() {
        mapper.upsert(device("t1", "u1", "aa"));
        mapper.upsert(device("t1", "u1", "bb"));
        List<PushDeviceEntity> rows = mapper.listByOwners(List.of("u1"));
        assertEquals(1, rows.size());
        assertEquals("bb", rows.getFirst().getDeviceToken());
    }

    @Test void anotherAccountOnTheSamePhoneTakesTheTokenOver() {
        mapper.upsert(device("t1", "u1", "aa"));
        mapper.deleteOtherHolders("aa", "t2");
        mapper.upsert(device("t2", "u2", "aa"));
        assertTrue(mapper.listByOwners(List.of("u1")).isEmpty());
        assertEquals("t2", mapper.listByOwners(List.of("u2")).getFirst().getTerminalId());
    }

    @Test void disabledTerminalsAreNotListedAndDeletesWork() {
        mapper.upsert(device("t1", "u1", "aa"));
        mapper.upsert(device("t3", "u1", "cc"));
        assertEquals(List.of("t1"), mapper.listByOwners(List.of("u1")).stream().map(PushDeviceEntity::getTerminalId).toList());
        mapper.deleteByToken("aa");
        assertTrue(mapper.listByOwners(List.of("u1")).isEmpty());
        mapper.upsert(device("t1", "u1", "aa"));
        mapper.deleteByTerminal("t1");
        assertTrue(mapper.listByOwners(List.of("u1")).isEmpty());
        mapper.upsert(device("t1", "u1", "aa"));
        mapper.deleteByOwner("u1");
        assertTrue(mapper.listByOwners(List.of("u1")).isEmpty());
    }

    /** create-database.sql and the migration script are two hand-written table definitions; their columns must match */
    @Test void migrationMatchesCreateDatabase() throws Exception {
        String create = Files.readString(Path.of("docs/create-database.sql"));
        String alter = Files.readString(Path.of("docs/alter-2026-11-03-push-devices.sql"));
        String body = create.substring(create.indexOf("CREATE TABLE `push_devices` ("));
        body = body.substring(0, body.indexOf(";", body.indexOf(") ENGINE=")) + 1);
        assertTrue(alter.contains(body.substring("CREATE TABLE `push_devices` (".length()).strip()));
    }
}
