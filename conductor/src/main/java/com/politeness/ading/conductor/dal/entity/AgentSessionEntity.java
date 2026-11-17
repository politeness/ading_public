package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * agent_sessions — an agent's CLI session resume token within a conversation.
 * Unique key (conversation_id, user_id): an agent gets its own thread per conversation, never shared.
 * Note: the read position is not stored here; it lives in conversation_user_rel.last_read_seq.
 */
@Data
public class AgentSessionEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        sessionId;
    private String        conversationId;
    private String        userId;
    private String        providerThreadId;
    private String        workspacePath;
    private String        status;

    public static final String STATUS_ACTIVE = "ACTIVE";
    public static final String STATUS_STALE  = "STALE";
}
