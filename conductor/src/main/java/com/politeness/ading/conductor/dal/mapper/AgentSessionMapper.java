package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.AgentSessionEntity;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface AgentSessionMapper {

    @Insert("""
            INSERT INTO agent_sessions (session_id, conversation_id, user_id,
                                        provider_thread_id, workspace_path, status)
            VALUES (#{sessionId}, #{conversationId}, #{userId},
                    #{providerThreadId}, #{workspacePath}, #{status})
            ON DUPLICATE KEY UPDATE
                provider_thread_id = VALUES(provider_thread_id),
                workspace_path     = VALUES(workspace_path),
                status             = VALUES(status)
            """)
    int upsert(AgentSessionEntity session);

    @Select("""
            SELECT * FROM agent_sessions
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    AgentSessionEntity find(@Param("conversationId") String conversationId,
                            @Param("userId") String userId);

    @Update("""
            UPDATE agent_sessions SET status = #{status}
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    int updateStatus(@Param("conversationId") String conversationId,
                     @Param("userId") String userId,
                     @Param("status") String status);
}
