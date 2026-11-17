package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.MessageEntity;
import java.util.List;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

@Mapper
public interface MessageMapper {

    /**
     * Plain INSERT; does not swallow duplicate keys.
     *
     * Idempotency is handled by the caller: look up by message_id first, enter the transaction only if not found;
     * if a concurrent insert still hits the unique key, the exception rolls back the whole transaction — including the last_seq increment.
     * This is crucial: seq must have no gaps, so the client can use "seq == local max + 1" to detect lost messages.
     */
    @Insert("""
            INSERT INTO messages (message_id, conversation_id, seq, sender_id, content,
                                  type, mentions, reply_to, status, turn_id, is_deleted,
                                  internal, report, failed, extra, attachments)
            VALUES (#{messageId}, #{conversationId}, #{seq}, #{senderId}, #{content},
                    #{type}, #{mentions}, #{replyTo}, #{status}, #{turnId}, 0,
                    #{internal}, #{report}, #{failed}, #{extra}, #{attachments})
            """)
    int insert(MessageEntity message);

    @Select("SELECT * FROM messages WHERE message_id = #{messageId}")
    MessageEntity findByMessageId(@Param("messageId") String messageId);

    /** Incremental catch-up: after reconnecting, fetch messages after seq */
    @Select("""
            SELECT * FROM messages
             WHERE conversation_id = #{conversationId} AND seq > #{afterSeq} AND is_deleted = 0
             ORDER BY seq ASC
             LIMIT #{limit}
            """)
    List<MessageEntity> listAfterSeq(@Param("conversationId") String conversationId,
                                     @Param("afterSeq") long afterSeq,
                                     @Param("limit") int limit);

    /** History paging: scroll up to read older messages */
    @Select("""
            SELECT * FROM messages
             WHERE conversation_id = #{conversationId} AND seq < #{beforeSeq} AND is_deleted = 0
             ORDER BY seq DESC
             LIMIT #{limit}
            """)
    List<MessageEntity> listBeforeSeq(@Param("conversationId") String conversationId,
                                      @Param("beforeSeq") long beforeSeq,
                                      @Param("limit") int limit);

    @Select("""
            SELECT * FROM messages
             WHERE conversation_id = #{conversationId} AND is_deleted = 0
             ORDER BY seq DESC
             LIMIT #{limit}
            """)
    List<MessageEntity> listLatest(@Param("conversationId") String conversationId,
                                   @Param("limit") int limit);

    @Select("""
            SELECT * FROM messages
             WHERE conversation_id = #{conversationId} AND is_deleted = 0
             ORDER BY seq DESC LIMIT 1
            """)
    MessageEntity findLatest(@Param("conversationId") String conversationId);
}
