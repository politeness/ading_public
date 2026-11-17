package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** conversation_user_rel — conversation members; last_read_seq is the single read position across the whole system */
@Data
public class ConversationUserRelEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        conversationId;
    private String        userId;
    private String        role;
    private Long          lastReadSeq;
    private Long          lastDeliveredSeq;
    /** Sequence the Agent has processed up to; when empty, falls back to lastReadSeq */
    private Long          lastProcessedSeq;
    /** The first unread message that @-mentions this human; empty if none */
    private Long          firstUnreadMentionSeq;
    private Boolean       paused;
    private Boolean       resumeOnContinue;
    private Boolean       ownerPaused;

    public static final String ROLE_LEADER   = "LEADER";
    public static final String ROLE_ENGINEER = "ENGINEER";
    public static final String ROLE_REVIEWER = "REVIEWER";
    public static final String ROLE_OBSERVER = "OBSERVER";
}
