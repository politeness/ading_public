package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.Mockito.*;

import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.dal.mapper.AgentSessionMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.concurrent.*;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.mybatis.spring.transaction.SpringManagedTransactionFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

class AgentRegistrationConcurrencyTest {
    @Test
    void overlappingRegistrationsConvergeOnOneCommittedIdentity() throws Exception {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:agent-race;MODE=MySQL;DB_CLOSE_DELAY=-1;LOCK_TIMEOUT=10000");
        JdbcTemplate jdbc = new JdbcTemplate(source);
        jdbc.execute("CREATE TABLE users (id BIGINT AUTO_INCREMENT PRIMARY KEY,user_id VARCHAR(64) UNIQUE,username VARCHAR(64) UNIQUE,display_name VARCHAR(64),is_agent BOOLEAN,password VARCHAR(255),status VARCHAR(32),agent_type VARCHAR(32),agent_version VARCHAR(64),permission_level VARCHAR(32),persona VARCHAR(255),owner VARCHAR(64),terminal_id VARCHAR(64),local_uuid VARCHAR(64),readiness VARCHAR(32),UNIQUE(terminal_id,local_uuid))");
        Configuration config = new Configuration(new Environment("test", new SpringManagedTransactionFactory(), source));
        config.setMapUnderscoreToCamelCase(true); config.addMapper(UserMapper.class);
        SqlSessionTemplate session = new SqlSessionTemplate(new SqlSessionFactoryBuilder().build(config));
        UserMapper delegate = session.getMapper(UserMapper.class);
        UserMapper users = mock(UserMapper.class, invocation -> {
            try { return invocation.getMethod().invoke(delegate, invocation.getArguments()); }
            catch (java.lang.reflect.InvocationTargetException error) { throw error.getCause(); }
        });
        CyclicBarrier reads = new CyclicBarrier(2);
        doAnswer(call -> { Object found = delegate.findAgentByTerminalAndLocalUuid("d_test", "antigravity@test"); reads.await(5, TimeUnit.SECONDS); return found; })
                .when(users).findAgentByTerminalAndLocalUuid("d_test", "antigravity@test");
        AgentService agents = new AgentService(users, mock(AgentSessionMapper.class), mock(RelationService.class), mock(NodeRegistry.class), new IdGenerator());
        TransactionTemplate transaction = new TransactionTemplate(new DataSourceTransactionManager(source));
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<UserEntity> register = () -> transaction.execute(status -> agents.register("d_test", "u_owner", "antigravity@test", "ANTIGRAVITY", "1", null));
            Future<UserEntity> first = pool.submit(register), second = pool.submit(register);
            assertEquals(first.get(15, TimeUnit.SECONDS).getUserId(), second.get(15, TimeUnit.SECONDS).getUserId());
            assertEquals(1, jdbc.queryForObject("SELECT COUNT(*) FROM users", Integer.class));
        } finally {
            pool.shutdownNow(); pool.awaitTermination(5, TimeUnit.SECONDS); jdbc.execute("DROP TABLE users");
        }
    }
}
