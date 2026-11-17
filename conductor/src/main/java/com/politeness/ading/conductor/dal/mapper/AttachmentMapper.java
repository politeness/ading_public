package com.politeness.ading.conductor.dal.mapper;

import com.politeness.ading.conductor.dal.entity.AttachmentEntity;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface AttachmentMapper {

    @Insert("""
            INSERT INTO attachments (attachment_id, conversation_id, uploader_id, name, mime_type,
                                     size_bytes, kind, object_key, status)
            VALUES (#{attachmentId}, #{conversationId}, #{uploaderId}, #{name}, #{mimeType},
                    #{sizeBytes}, #{kind}, #{objectKey}, #{status})
            """)
    int insert(AttachmentEntity attachment);

    @Select("SELECT * FROM attachments WHERE attachment_id = #{attachmentId}")
    AttachmentEntity findByAttachmentId(@Param("attachmentId") String attachmentId);

    /** On message send, confirm the actual size in OSS and bind the attachment to this message */
    @Update("""
            UPDATE attachments
               SET status = 'READY', size_bytes = #{sizeBytes}, message_id = #{messageId}
             WHERE attachment_id = #{attachmentId}
            """)
    int markSent(@Param("attachmentId") String attachmentId,
                 @Param("messageId") String messageId,
                 @Param("sizeBytes") long sizeBytes);
}
