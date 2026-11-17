package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * attachments — images, videos and files in messages. The file itself is in OSS; this only stores metadata and ownership.
 *
 * Flow: client registers first (gets a time-limited upload URL) → uploads directly to OSS → sends the message with attachment_id.
 * Only when the message is sent do we confirm the file really exists in OSS and bind it to the message; attachments never sent stay PENDING.
 */
@Data
public class AttachmentEntity {
    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        attachmentId;
    private String        conversationId;
    private String        uploaderId;
    private String        messageId;
    private String        name;
    private String        mimeType;
    private Long          sizeBytes;
    private String        kind;
    private String        objectKey;
    private String        status;

    public static final String KIND_IMAGE = "IMAGE";
    public static final String KIND_VIDEO = "VIDEO";
    public static final String KIND_FILE  = "FILE";

    public static final String STATUS_PENDING = "PENDING";
    public static final String STATUS_READY   = "READY";
}
