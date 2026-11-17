package com.politeness.ading.conductor.service;
import static org.junit.jupiter.api.Assertions.*;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.Test;
import org.mybatis.spring.SqlSessionTemplate;
import org.mybatis.spring.transaction.SpringManagedTransactionFactory;
import org.springframework.jdbc.core.JdbcTemplate;
class SharedAgentSyncTest {
    @Test void executorCanDiscoverAnAgentConversationWithoutAddingItsOwnerAsAHuman() {
        JdbcDataSource source = new JdbcDataSource();
        source.setURL("jdbc:h2:mem:shared-agent-sync;MODE=MySQL;DB_CLOSE_DELAY=-1");
        JdbcTemplate db = new JdbcTemplate(source);
        try {
            db.execute("CREATE TABLE users (user_id VARCHAR(64),is_agent BOOLEAN,owner VARCHAR(64),terminal_id VARCHAR(64))");
            db.execute("CREATE TABLE conversations (id BIGINT,conversation_id VARCHAR(64),last_seq BIGINT,is_deleted BOOLEAN,gmt_modified TIMESTAMP)");
            db.execute("CREATE TABLE conversation_user_rel (conversation_id VARCHAR(64),user_id VARCHAR(64),last_read_seq BIGINT DEFAULT 0)");
            db.update("INSERT INTO users VALUES ('agent',true,'owner','executor')");
            db.update("INSERT INTO conversations VALUES (1,'shared',5,false,CURRENT_TIMESTAMP)");
            db.update("INSERT INTO conversation_user_rel (conversation_id,user_id) VALUES ('shared','friend'),('shared','agent')");
            Configuration config = new Configuration(new Environment("test", new SpringManagedTransactionFactory(), source));
            config.setMapUnderscoreToCamelCase(true); config.addMapper(ConversationMapper.class);
            config.addMapper(ConversationUserRelMapper.class);
            var mapper = new SqlSessionTemplate(new SqlSessionFactoryBuilder().build(config)).getMapper(ConversationMapper.class);
            assertEquals(1, mapper.listForTerminal("owner", "executor", 100).size());
            assertEquals(0, mapper.listForTerminal("owner", "wrong-terminal", 100).size());
            assertEquals(0, mapper.listForTerminal("stranger", "executor", 100).size());
            assertEquals(1, mapper.listByMember("owner", 100).size());
            assertEquals(0, mapper.listByMember("stranger", 100).size());
            assertEquals("shared", mapper.syncCursors("owner", 0, 100).getFirst().conversationId());
            assertEquals(0, mapper.syncCursors("stranger", 0, 100).size());
            assertEquals("shared", mapper.syncCursorsForTerminal("owner", "executor", 0, 100).getFirst().conversationId());
            assertEquals(0, mapper.syncCursorsForTerminal("owner", "executor", 1, 100).size());
            db.update("UPDATE conversation_user_rel SET last_read_seq = 3 WHERE user_id = 'friend'");
            assertEquals(3, mapper.syncCursors("friend", 0, 100).getFirst().lastReadSeq());
            assertEquals(3, mapper.syncCursorsForTerminal("friend", "phone", 0, 100).getFirst().lastReadSeq());
            var members = new SqlSessionTemplate(new SqlSessionFactoryBuilder().build(config)).getMapper(ConversationUserRelMapper.class);
            assertEquals(java.util.Set.of("owner", "friend", "agent"), new java.util.HashSet<>(members.listViewerIds("shared")));
            assertEquals(0, members.advanceReadSeq("shared", "owner", 5), "viewer must not alter participants' read state");
            assertEquals(1, members.advanceReadSeq("shared", "friend", 5));
            assertEquals(0, members.advanceReadSeq("shared", "friend", 4), "out-of-order receipt cannot rewind");
            assertEquals(0, members.advanceReadSeq("shared", "friend", 5), "duplicate receipt must not broadcast again");
            assertEquals(5, mapper.syncCursorsForTerminal("friend", "another-phone", 0, 100).getFirst().lastReadSeq());
            assertEquals(0, mapper.syncCursorsForTerminal("owner", "executor", 0, 100).getFirst().lastReadSeq(),
                    "executor must not inherit another human's read position");
        } finally { db.execute("DROP ALL OBJECTS"); }
    }
}
