package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface ConversationMapper {

    record SyncCursor(long syncId, String conversationId, long lastSeq, long lastReadSeq) {}

    /** Stable keyset pagination: busy conversations cannot push older ones past a fixed limit. */
    @Select("""
            SELECT c.id AS sync_id, c.conversation_id, c.last_seq, COALESCE(mine.last_read_seq, 0) AS last_read_seq FROM conversations c
            LEFT JOIN conversation_user_rel mine ON mine.conversation_id = c.conversation_id AND mine.user_id = #{userId}
            WHERE c.is_deleted = 0 AND c.id > #{afterId} AND EXISTS (
                SELECT 1 FROM conversation_user_rel r LEFT JOIN users a ON a.user_id = r.user_id
                WHERE r.conversation_id = c.conversation_id AND (r.user_id = #{userId} OR (a.is_agent = 1 AND a.owner = #{userId})))
            ORDER BY c.id LIMIT #{limit}
            """)
    List<SyncCursor> syncCursors(@Param("userId") String userId, @Param("afterId") long afterId,
                               @Param("limit") int limit);

    @Select("""
            SELECT c.* FROM conversations c WHERE c.is_deleted = 0 AND EXISTS (
                SELECT 1 FROM conversation_user_rel r LEFT JOIN users a ON a.user_id = r.user_id
                 WHERE r.conversation_id = c.conversation_id
                   AND (r.user_id = #{userId} OR (a.is_agent = 1 AND a.owner = #{userId} AND a.terminal_id = #{terminalId})))
             ORDER BY c.gmt_modified DESC, c.id DESC LIMIT #{limit}
            """)
    List<ConversationEntity> listForTerminal(@Param("userId") String userId, @Param("terminalId") String terminalId, @Param("limit") int limit);

    @Select("""
            SELECT c.id AS sync_id, c.conversation_id, c.last_seq, COALESCE(mine.last_read_seq, 0) AS last_read_seq
              FROM conversations c
              LEFT JOIN conversation_user_rel mine ON mine.conversation_id = c.conversation_id AND mine.user_id = #{userId}
             WHERE c.is_deleted = 0 AND c.id > #{afterId} AND EXISTS (
                SELECT 1 FROM conversation_user_rel r LEFT JOIN users a ON a.user_id = r.user_id
                 WHERE r.conversation_id = c.conversation_id
                   AND (r.user_id = #{userId} OR (a.is_agent = 1 AND a.owner = #{userId} AND a.terminal_id = #{terminalId})))
             ORDER BY c.id LIMIT #{limit}
            """)
    List<SyncCursor> syncCursorsForTerminal(@Param("userId") String userId, @Param("terminalId") String terminalId,
                                           @Param("afterId") long afterId, @Param("limit") int limit);

    @Insert("""
            INSERT INTO conversations (conversation_id, name, creator, owner, type,
                               last_seq, terminal_id, state, round_budget,
                               workspace_id, status, paused, auto_title, seed_key, extra, is_deleted)
            VALUES (#{conversationId}, #{name}, #{creator}, #{owner}, #{type},
                    0, #{terminalId}, 'IDLE', #{roundBudget},
                    #{workspaceId}, #{status}, #{paused}, #{autoTitle}, #{seedKey}, #{extra}, 0)
            """)
    int insert(ConversationEntity conversation);

    /** Includes deleted conversations; deciding "does it exist" is left to ConversationService.require */
    @Select("SELECT * FROM conversations WHERE conversation_id = #{conversationId}")
    ConversationEntity findByConversationId(@Param("conversationId") String conversationId);

    @Select("""
            SELECT c.* FROM conversations c
             WHERE c.is_deleted = 0 AND EXISTS (
                SELECT 1 FROM conversation_user_rel r LEFT JOIN users a ON a.user_id = r.user_id
                WHERE r.conversation_id = c.conversation_id AND (r.user_id = #{userId} OR (a.is_agent = 1 AND a.owner = #{userId})))
             ORDER BY c.gmt_modified DESC, c.id DESC
             LIMIT #{limit}
            """)
    List<ConversationEntity> listByMember(@Param("userId") String userId, @Param("limit") int limit);

    @Select("SELECT conversation_id FROM conversations WHERE conversation_id = #{conversationId} FOR UPDATE")
    String lockMembers(@Param("conversationId") String conversationId);

    /**
     * Sequence generator. Within a transaction call this first to take the row lock, then read back with selectLastSeq, then insert the message.
     * The row lock only contends within one conversation — and group chats must be serialized anyway, so the constraint and performance line up.
     */
    @Update("UPDATE conversations SET last_seq = last_seq + 1 WHERE conversation_id = #{conversationId}")
    int bumpSeq(@Param("conversationId") String conversationId);

    @Select("SELECT last_seq FROM conversations WHERE conversation_id = #{conversationId}")
    Long selectLastSeq(@Param("conversationId") String conversationId);

    /**
     * Updates only fields that were passed. gmt_modified is explicitly preserved: pausing or changing the workspace is not new chat activity
     * and must not bump the conversation to the top of the list; callers that need that call touch separately.
     */
    @Update("""
            UPDATE conversations
               SET name         = COALESCE(#{name}, name),
                   owner        = COALESCE(#{owner}, owner),
                   state        = COALESCE(#{state}, state),
                   workspace_id = COALESCE(#{workspaceId}, workspace_id),
                   status       = COALESCE(#{status}, status),
                   paused       = COALESCE(#{paused}, paused),
                   auto_title   = COALESCE(#{autoTitle}, auto_title),
                   extra        = COALESCE(#{extra}, extra),
                   gmt_modified = gmt_modified
             WHERE conversation_id = #{conversationId}
            """)
    int updateMutable(ConversationEntity conversation);

    @Update("UPDATE conversations SET gmt_modified = CURRENT_TIMESTAMP WHERE conversation_id = #{conversationId}")
    int touch(@Param("conversationId") String conversationId);

    @Update("UPDATE conversations SET is_deleted = 1, gmt_modified = gmt_modified WHERE conversation_id = #{conversationId}")
    int softDelete(@Param("conversationId") String conversationId);

    /** When a workspace is deleted, move its conversations to "No workspace"; the conversations are not deleted and their ordering does not change */
    @Update("""
            UPDATE conversations
               SET workspace_id = #{toWorkspaceId},
                   gmt_modified = gmt_modified
             WHERE workspace_id = #{fromWorkspaceId}
            """)
    int moveWorkspace(@Param("fromWorkspaceId") String fromWorkspaceId,
                      @Param("toWorkspaceId") String toWorkspaceId);
}
