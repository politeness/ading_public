package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.ConversationUserRelEntity;
import java.util.List;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface ConversationUserRelMapper {

    @Insert("""
            INSERT INTO conversation_user_rel (conversation_id, user_id, role, last_read_seq, last_delivered_seq)
            VALUES (#{conversationId}, #{userId}, #{role}, 0, 0)
            ON DUPLICATE KEY UPDATE role = VALUES(role)
            """)
    int upsert(ConversationUserRelEntity rel);

    @Update("""
            UPDATE conversation_user_rel r JOIN users a ON a.user_id = r.user_id AND a.is_agent = 1 AND a.owner = #{owner}
               SET r.owner_paused = #{paused}
             WHERE r.conversation_id = #{conversationId}
            """)
    int setOwnerPaused(@Param("conversationId") String conversationId, @Param("owner") String owner, @Param("paused") boolean paused);

    @Select("SELECT * FROM conversation_user_rel WHERE conversation_id = #{conversationId} ORDER BY id")
    List<ConversationUserRelEntity> listMembers(@Param("conversationId") String conversationId);

    @Select("""
            SELECT * FROM conversation_user_rel
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    ConversationUserRelEntity findMember(@Param("conversationId") String conversationId,
                                         @Param("userId") String userId);

    @Select("SELECT user_id FROM conversation_user_rel WHERE conversation_id = #{conversationId}")
    List<String> listMemberIds(@Param("conversationId") String conversationId);

    @Select("""
            SELECT r.user_id FROM conversation_user_rel r WHERE r.conversation_id = #{conversationId}
            UNION
            SELECT a.owner FROM conversation_user_rel r JOIN users a ON a.user_id = r.user_id
             WHERE r.conversation_id = #{conversationId} AND a.is_agent = 1 AND a.owner IS NOT NULL
            """)
    List<String> listViewerIds(@Param("conversationId") String conversationId);

    @Delete("""
            DELETE FROM conversation_user_rel
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    int removeMember(@Param("conversationId") String conversationId, @Param("userId") String userId);

    /** Updates only fields that were passed: role, paused in this conversation only, and whether to auto-resume when the conversation continues */
    @Update("""
            UPDATE conversation_user_rel
               SET role               = COALESCE(#{role}, role),
                   paused             = COALESCE(#{paused}, paused),
                   resume_on_continue = COALESCE(#{resumeOnContinue}, resume_on_continue)
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    int updateMember(ConversationUserRelEntity rel);

    /** The read position only moves forward, so out-of-order requests cannot pull it back */
    @Update("""
            UPDATE conversation_user_rel
               SET last_read_seq = GREATEST(last_read_seq, #{seq})
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
               AND last_read_seq < #{seq}
            """)
    int advanceReadSeq(@Param("conversationId") String conversationId,
                       @Param("userId") String userId,
                       @Param("seq") long seq);

    /** Records the first message an @-mentioned human has not read yet. Agents don't rely on this; the scheduler dispatches work from the message's own mentions */
    @Update("""
            UPDATE conversation_user_rel r
              JOIN users u ON u.user_id = r.user_id AND u.is_agent = 0
               SET r.first_unread_mention_seq = COALESCE(r.first_unread_mention_seq, #{seq})
             WHERE r.conversation_id = #{conversationId}
               AND r.user_id <> #{senderId}
               AND r.last_read_seq < #{seq}
               AND FIND_IN_SET(r.user_id, #{mentions}) > 0
            """)
    int markMentioned(@Param("conversationId") String conversationId,
                      @Param("senderId") String senderId,
                      @Param("mentions") String mentions,
                      @Param("seq") long seq);

    /** Read position moved past the first @: replace it with the next one after the read position, or clear it if none */
    @Update("""
            UPDATE conversation_user_rel r
               SET r.first_unread_mention_seq = (
                       SELECT MIN(m.seq) FROM messages m
                        WHERE m.conversation_id = r.conversation_id
                          AND m.seq > r.last_read_seq
                          AND m.is_deleted = 0
                          AND m.internal = 0
                          AND m.sender_id <> r.user_id
                          AND FIND_IN_SET(r.user_id, m.mentions) > 0)
             WHERE r.conversation_id = #{conversationId}
               AND r.user_id = #{userId}
               AND r.first_unread_mention_seq <= r.last_read_seq
            """)
    int refreshFirstUnreadMention(@Param("conversationId") String conversationId,
                                  @Param("userId") String userId);

    @Update("""
            UPDATE conversation_user_rel
               SET last_delivered_seq = GREATEST(last_delivered_seq, #{seq})
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    int advanceDeliveredSeq(@Param("conversationId") String conversationId,
                            @Param("userId") String userId,
                            @Param("seq") long seq);

    /**
     * The Agent's processing watermark, kept separate from humans' read position; it also only moves forward.
     * When never recorded, it starts from the read position, consistent with markProcessed in the standalone version.
     */
    @Update("""
            UPDATE conversation_user_rel
               SET last_processed_seq = CASE
                       WHEN #{seq} > COALESCE(last_processed_seq, last_read_seq) THEN #{seq}
                       ELSE last_processed_seq
                   END
             WHERE conversation_id = #{conversationId} AND user_id = #{userId}
            """)
    int advanceProcessedSeq(@Param("conversationId") String conversationId,
                            @Param("userId") String userId,
                            @Param("seq") long seq);

    @Select("""
            SELECT COUNT(1) FROM messages m
             WHERE m.conversation_id = #{conversationId}
               AND m.is_deleted = 0
               AND m.seq > (SELECT last_read_seq FROM conversation_user_rel
                             WHERE conversation_id = #{conversationId} AND user_id = #{userId})
            """)
    int countUnread(@Param("conversationId") String conversationId, @Param("userId") String userId);

    /** Mobile badge: total unread across all conversations, counted the same way as countUnread so the numbers in the phone list match */
    @Select("""
            SELECT COUNT(1) FROM conversation_user_rel r
              JOIN messages m ON m.conversation_id = r.conversation_id AND m.seq > r.last_read_seq AND m.is_deleted = 0
             WHERE r.user_id = #{userId}
            """)
    int countUnreadOfUser(@Param("userId") String userId);
}
