package com.politeness.ading.ops.dal.mapper;

import com.politeness.ading.ops.dal.AttachmentRow;
import com.politeness.ading.ops.dal.ContactRow;
import com.politeness.ading.ops.dal.FeedbackRow;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import org.apache.ibatis.annotations.Insert;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

/** Issue reports and user contacts are both ops' own tables. Idempotent by unique id: conductor timeout retries don't create an extra row. */
@Mapper
public interface SupportInboxMapper {

    @Insert("""
            INSERT IGNORE INTO ops_feedback
              (report_id, user_id, terminal_id, status, description, occurred_at, submitted_at, app_version, channel,
               platform, arch, mode, object_prefix)
            VALUES
              (#{reportId}, #{userId}, #{terminalId}, 'PENDING', #{description}, #{occurredAt}, #{submittedAt}, #{appVersion}, #{channel},
               #{platform}, #{arch}, #{mode}, #{objectPrefix})
            """)
    int insertFeedback(FeedbackRow row);

    @Insert("""
            INSERT IGNORE INTO ops_contact
              (contact_id, user_id, terminal_id, subject, content, reply_to, submitted_at, app_version, channel, platform, arch, mode)
            VALUES
              (#{contactId}, #{userId}, #{terminalId}, #{subject}, #{content}, #{replyTo}, #{submittedAt}, #{appVersion}, #{channel},
               #{platform}, #{arch}, #{mode})
            """)
    int insertContact(ContactRow row);

    @Insert("""
            INSERT INTO ops_support_attachment
              (owner_type, owner_id, kind, name, object_key, content_type, size_bytes)
            VALUES
              (#{ownerType}, #{ownerId}, #{kind}, #{name}, #{objectKey}, #{contentType}, #{sizeBytes})
            """)
    int insertAttachment(AttachmentRow row);

    @Select("""
            <script>
            SELECT * FROM ops_feedback
            <choose>
              <when test="status == 'ACTIVE'">WHERE status IN ('ACCEPTED', 'IN_PROGRESS')</when>
              <when test="status == 'COMPLETED'">WHERE status IN ('IGNORED', 'RESOLVED')</when>
              <when test="status != null">WHERE status = #{status}</when>
            </choose>
            ORDER BY id DESC
            LIMIT #{size} OFFSET #{offset}
            </script>
            """)
    List<FeedbackRow> listFeedback(@Param("status") String status, @Param("offset") int offset, @Param("size") int size);

    @Select("""
            <script>
            SELECT COUNT(*) FROM ops_feedback
            <choose>
              <when test="status == 'ACTIVE'">WHERE status IN ('ACCEPTED', 'IN_PROGRESS')</when>
              <when test="status == 'COMPLETED'">WHERE status IN ('IGNORED', 'RESOLVED')</when>
              <when test="status != null">WHERE status = #{status}</when>
            </choose>
            </script>
            """)
    long countFeedback(@Param("status") String status);

    @Select("SELECT status, COUNT(*) AS total FROM ops_feedback GROUP BY status")
    List<Map<String, Object>> countFeedbackByStatus();

    @Select("SELECT * FROM ops_feedback WHERE report_id = #{reportId}")
    FeedbackRow findFeedback(@Param("reportId") String reportId);

    /** Manual changes only move between pending, ignored and accepted; resolved is the end of the processing workflow and can't be changed back manually. */
    @Update("""
            UPDATE ops_feedback
               SET status = #{status}, handled_by = #{handledBy}, status_changed_at = #{changedAt}
             WHERE report_id = #{reportId} AND (status IN ('PENDING', 'IGNORED', 'ACCEPTED')
                OR (status = 'IN_PROGRESS' AND #{status} IN ('ACCEPTED', 'IGNORED')))
            """)
    int changeStatus(@Param("reportId") String reportId, @Param("status") String status,
                     @Param("handledBy") String handledBy, @Param("changedAt") LocalDateTime changedAt);

    /** The conditional update ensures only one call succeeds when claimed concurrently. */
    @Update("""
            UPDATE ops_feedback
               SET status = 'IN_PROGRESS', handled_by = #{handledBy}, status_changed_at = #{changedAt}
             WHERE report_id = #{reportId} AND status = 'ACCEPTED'
            """)
    int claim(@Param("reportId") String reportId, @Param("handledBy") String handledBy,
              @Param("changedAt") LocalDateTime changedAt);

    /** Only the claimant can close; status and ownership are checked in the same conditional update. */
    @Update("""
            UPDATE ops_feedback
               SET status = 'RESOLVED', status_changed_at = #{changedAt}
             WHERE report_id = #{reportId} AND status = 'IN_PROGRESS' AND handled_by = #{handledBy}
            """)
    int resolve(@Param("reportId") String reportId, @Param("handledBy") String handledBy,
                @Param("changedAt") LocalDateTime changedAt);

    /** Closed after confirmation by ops staff; the time is recorded on the terminal state, which can't be changed again. */
    @Update("""
            UPDATE ops_feedback
               SET status = 'RESOLVED', handled_by = #{handledBy}, status_changed_at = #{changedAt}
             WHERE report_id = #{reportId} AND status = 'IN_PROGRESS'
            """)
    int confirmResolved(@Param("reportId") String reportId, @Param("handledBy") String handledBy,
                        @Param("changedAt") LocalDateTime changedAt);

    @Select("SELECT * FROM ops_contact ORDER BY id DESC LIMIT #{size} OFFSET #{offset}")
    List<ContactRow> listContacts(@Param("offset") int offset, @Param("size") int size);

    @Select("SELECT COUNT(*) FROM ops_contact")
    long countContacts();

    @Select("SELECT * FROM ops_contact WHERE contact_id = #{contactId}")
    ContactRow findContact(@Param("contactId") String contactId);

    @Select("""
            <script>
            SELECT * FROM ops_support_attachment
             WHERE owner_type = #{ownerType} AND owner_id IN
             <foreach item="id" collection="ownerIds" open="(" separator="," close=")">#{id}</foreach>
             ORDER BY id
            </script>
            """)
    List<AttachmentRow> findAttachments(@Param("ownerType") String ownerType, @Param("ownerIds") List<String> ownerIds);

    @Select("SELECT * FROM ops_support_attachment WHERE id = #{id}")
    AttachmentRow findAttachment(@Param("id") long id);
}
