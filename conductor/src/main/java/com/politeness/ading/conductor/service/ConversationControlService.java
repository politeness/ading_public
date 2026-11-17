package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.error.AgentError;
import com.politeness.ading.conductor.error.CommonError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.JsonNode;

/** Task-scoped commands, routed only to the authenticated owner's execution nodes. */
@Service
public class ConversationControlService {
    private final ConversationService conversations;
    private final TerminalMapper terminals;
    private final NodeRegistry nodes;

    public ConversationControlService(ConversationService conversations, TerminalMapper terminals, NodeRegistry nodes) {
        this.conversations = conversations;
        this.terminals = terminals;
        this.nodes = nodes;
    }

    @Transactional
    public void request(String owner, String source, JsonNode payload) {
        String requestId = text(payload, "requestId");
        String conversationId = text(payload, "conversationId");
        String action = text(payload, "action");
        try {
            validate(requestId, conversationId, action);
            requireTerminal(owner, source);
            conversations.requireAccessible(conversationId, owner);
            if (action.equals("resume")) conversations.requireNotOwnerPaused(conversationId, owner);
            Set<String> targets = targets(owner, conversationId);
            if (targets.isEmpty()) throw new BizException(CommonError.BAD_REQUEST);
            // Validate the entire group first; never silently stop only a subset. An unknown state (failed broker
            // query) is a PresenceUnknownException, so the requester gets an error receipt instead of a timeout.
            for (String target : targets) {
                if (!nodes.isTerminalOnline(target)) throw new BizException(AgentError.AGENT_OFFLINE);
            }
            long expiresAt = System.currentTimeMillis() + 30_000;
            nodes.send(source, NodeFrame.of(FrameType.CONVERSATION_CONTROL_ACCEPTED,
                    Map.of("requestId", requestId, "conversationId", conversationId, "action", action,
                            "terminalIds", targets)));
            for (String target : targets) {
                nodes.send(target, NodeFrame.of(FrameType.CONVERSATION_CONTROL,
                        Map.of("requestId", requestId, "conversationId", conversationId, "action", action,
                                "requesterTerminalId", source, "expiresAt", expiresAt)));
            }
        } catch (BizException error) {
            nodes.send(source, NodeFrame.of(FrameType.CONVERSATION_CONTROL_ACCEPTED,
                    Map.of("requestId", requestId, "conversationId", conversationId, "action", action,
                            "error", error.getError().code())));
        }
    }

    public void result(String owner, String source, JsonNode payload) {
        String requestId = text(payload, "requestId");
        String conversationId = text(payload, "conversationId");
        String action = text(payload, "action");
        String recipient = text(payload, "requesterTerminalId");
        validate(requestId, conversationId, action);
        requireTerminal(owner, source);
        var recipientTerminal = terminals.findByTerminalId(recipient);
        if (recipientTerminal == null) throw new BizException(AgentError.NOT_AGENT_OWNER);
        conversations.requireAccessible(conversationId, recipientTerminal.getOwner());
        if (!targets(recipientTerminal.getOwner(), conversationId).contains(source)) throw new BizException(AgentError.NOT_ON_THIS_NODE);
        nodes.send(recipient, NodeFrame.of(FrameType.CONVERSATION_CONTROL_RESULT,
                Map.of("requestId", requestId, "conversationId", conversationId, "action", action,
                        "terminalId", source, "ok", payload.path("ok").isBoolean() && payload.path("ok").asBoolean())));
    }

    private Set<String> targets(String owner, String conversationId) {
        Set<String> result = new LinkedHashSet<>();
        for (var user : conversations.memberUsers(conversationId)) {
            if (!Boolean.TRUE.equals(user.getIsAgent())) continue;
            conversations.requireAgentAccess(owner, user);
            if (user.getTerminalId() == null) throw new BizException(AgentError.AGENT_OFFLINE);
            result.add(user.getTerminalId());
        }
        return result;
    }

    private void requireTerminal(String owner, String terminalId) {
        var terminal = terminals.findByTerminalId(terminalId);
        if (terminal == null || !owner.equals(terminal.getOwner())) throw new BizException(AgentError.NOT_AGENT_OWNER);
    }

    private static String text(JsonNode value, String key) { return value.path(key).asText(""); }

    private static void validate(String requestId, String conversationId, String action) {
        if (requestId.isBlank() || requestId.length() > 100 || conversationId.isBlank() || conversationId.length() > 64
                || !(action.equals("pause") || action.equals("resume"))) throw new BizException(CommonError.BAD_REQUEST);
    }
}
