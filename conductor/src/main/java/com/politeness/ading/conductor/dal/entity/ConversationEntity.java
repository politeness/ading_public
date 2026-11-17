package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * conversations — one conversation = one task.
 *
 * You can have several conversations with the same person at once, each independent. So there is no member-pair fingerprint here,
 * and no "only one direct chat between two people" idempotency.
 * last_seq is the in-conversation message sequence generator.
 */
@Data
public class ConversationEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        conversationId;
    private String        name;
    private String        creator;
    private String        owner;
    private String        type;
    private Long          lastSeq;
    private String        terminalId;
    private String        state;
    private Integer       roundBudget;
    private String        workspaceId;
    private String        status;
    private Boolean       paused;
    private Boolean       autoTitle;
    private String        seedKey;
    /** Runtime state of the desktop scheduler, JSON text; the backend only stores it and never parses it */
    private String        extra;
    private Boolean       isDeleted;

    public static final String TYPE_DIRECT = "DIRECT";
    public static final String TYPE_GROUP  = "GROUP";

    public static final String STATE_IDLE    = "IDLE";
    public static final String STATE_RUNNING = "RUNNING";
    public static final String STATE_PAUSED  = "PAUSED";

    public static final String STATUS_ACTIVE   = "ACTIVE";
    public static final String STATUS_DONE     = "DONE";
    public static final String STATUS_ARCHIVED = "ARCHIVED";
}
