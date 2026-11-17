package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** messages — (conversation_id, seq) is the single anchor for incremental fetch and read position */
@Data
public class MessageEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        messageId;
    private String        conversationId;
    private Long          seq;
    private String        senderId;
    private String        content;
    private String        type;
    private String        mentions;
    private String        replyTo;
    private String        status;
    private String        turnId;
    private Boolean       isDeleted;
    private Boolean       internal;
    private Boolean       report;
    private Boolean       failed;
    /** Extra info from the desktop scheduler, JSON text; the backend only stores it and never parses it */
    private String        extra;
    /** Attachment list, JSON text (array of AttachmentView); empty when there are no attachments */
    private String        attachments;

    public static final String TYPE_USER   = "USER";
    public static final String TYPE_SYSTEM = "SYSTEM";
    public static final String TYPE_TASK   = "TASK";
    public static final String TYPE_SKILL  = "SKILL";

    public static final String STATUS_SENDING = "SENDING";
    public static final String STATUS_SENT    = "SENT";
    public static final String STATUS_FAILED  = "FAILED";
}
