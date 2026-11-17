package com.politeness.ading.conductor.dal.mapper;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.sql.Connection;
import java.sql.Statement;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** A user can have only one lock holder; an expired lock can be taken by someone else, after which the original holder can neither renew nor count as holding it. */
class KnowledgeLockMapperTest {

    private Connection keepAlive;
    private SqlSession session;
    private KnowledgeLockMapper mapper;

    @BeforeEach
    void setUp() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:knowledge_lock_" + System.nanoTime() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        keepAlive = dataSource.getConnection();
        try (Statement st = keepAlive.createStatement()) {
            st.execute("""
                    CREATE TABLE knowledge_locks (user_id VARCHAR(64) PRIMARY KEY, lock_token VARCHAR(64) NOT NULL,
                      expires_at DATETIME NOT NULL, gmt_created DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)""");
        }
        Configuration configuration = new Configuration(new Environment("test", new JdbcTransactionFactory(), dataSource));
        configuration.addMapper(KnowledgeLockMapper.class);
        session = new SqlSessionFactoryBuilder().build(configuration).openSession(true);
        mapper = session.getMapper(KnowledgeLockMapper.class);
    }

    @AfterEach
    void tearDown() throws Exception {
        session.close();
        keepAlive.close();
    }

    private void expire(String userId) throws Exception {
        try (Statement st = keepAlive.createStatement()) {
            st.execute("UPDATE knowledge_locks SET expires_at = TIMESTAMPADD(SECOND, -10, NOW()) WHERE user_id = '" + userId + "'");
        }
    }

    @Test
    void onlyOneHolderPerUser_differentUsersIndependent() {
        assertEquals(1, mapper.tryInsert("u_1", "a", 300));
        assertEquals(0, mapper.tryInsert("u_1", "b", 300));
        assertEquals(1, mapper.tryInsert("u_2", "c", 300));
        assertTrue(mapper.holds("u_1", "a"));
        assertFalse(mapper.holds("u_1", "b"));
        assertFalse(mapper.holds("u_2", "a"), "Another user's token does not count");
    }

    @Test
    void unexpiredLockCannotBeCleared_expiredLockCanBeTaken_originalHolderInvalidated() throws Exception {
        mapper.tryInsert("u_1", "a", 300);
        assertEquals(0, mapper.deleteExpired("u_1"));
        expire("u_1");
        assertFalse(mapper.holds("u_1", "a"));
        assertEquals(0, mapper.renew("u_1", "a", 300), "Cannot renew after expiry");
        assertEquals(1, mapper.deleteExpired("u_1"));
        assertEquals(1, mapper.tryInsert("u_1", "b", 300));
        assertEquals(0, mapper.renew("u_1", "a", 300), "Cannot renew after another holder takes it");
        assertEquals(0, mapper.release("u_1", "a"), "Old holder cannot release someone else's lock");
        assertTrue(mapper.holds("u_1", "b"));
    }

    @Test
    void renewAndRelease() {
        mapper.tryInsert("u_1", "a", 300);
        assertEquals(1, mapper.renew("u_1", "a", 300));
        assertEquals(1, mapper.release("u_1", "a"));
        assertEquals(1, mapper.tryInsert("u_1", "b", 300));
    }
}
