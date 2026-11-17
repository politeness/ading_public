package com.politeness.ading.conductor.controller.dto;

import com.fasterxml.jackson.annotation.JsonRawValue;
import java.time.Instant;
import java.util.List;

public record ConversationView(
        String conversationId,
        String name,
        String type,
        boolean shared,
        String creator,
        String owner,
        String state,
        long lastSeq,
        int unreadCount,
        MessageView lastMessage,
        List<MemberView> members,
        String workspaceId,
        String status,
        boolean paused,
        boolean autoTitle,
        String seedKey,
        /** Desktop scheduler runtime state; whatever JSON was stored is returned as is */
        @JsonRawValue String extra,
        Instant gmtCreated,
        Instant gmtModified) {
}
