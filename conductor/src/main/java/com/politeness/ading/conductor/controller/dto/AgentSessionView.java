package com.politeness.ading.conductor.controller.dto;

import com.politeness.ading.conductor.dal.entity.AgentSessionEntity;

public record AgentSessionView(
        String conversationId,
        String agentUserId,
        String providerThreadId,
        String workspacePath,
        String status) {

    public static AgentSessionView from(AgentSessionEntity session) {
        if (session == null) {
            return null;
        }
        return new AgentSessionView(
                session.getConversationId(),
                session.getUserId(),
                session.getProviderThreadId(),
                session.getWorkspacePath(),
                session.getStatus());
    }
}
