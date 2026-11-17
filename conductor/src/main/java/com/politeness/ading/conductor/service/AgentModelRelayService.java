package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.error.AgentError;
import com.politeness.ading.conductor.error.CommonError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;

/**
 * Read/set an Agent's model between computers of the same account: forward the request to the Agent's computer, then forward the reply back to the initiator.
 * Forward only; the selection is stored on the Agent's computer. Only the account's own Agents are accepted, not borrowed ones.
 */
@Service
public class AgentModelRelayService {
    private static final long EXPIRES_MS = 60_000;
    private static final int MAX_MODEL_ID = 200;
    private static final int MAX_MESSAGE = 500;

    private final AgentService agents;
    private final TerminalMapper terminals;
    private final NodeRegistry nodes;

    public AgentModelRelayService(AgentService agents, TerminalMapper terminals, NodeRegistry nodes) {
        this.agents = agents;
        this.terminals = terminals;
        this.nodes = nodes;
    }

    public void request(String owner, String source, JsonNode payload) {
        String requestId = text(payload, "requestId");
        String agentUserId = text(payload, "agentUserId");
        String action = text(payload, "action");
        requireIds(requestId, agentUserId);
        try {
            if (!action.equals("catalog") && !action.equals("set")) throw new BizException(CommonError.BAD_REQUEST);
            String modelId = payload.path("modelId").isTextual() ? payload.path("modelId").asText() : null;
            if (modelId != null && modelId.length() > MAX_MODEL_ID) throw new BizException(CommonError.BAD_REQUEST);
            String target = agents.requireOwnedAgent(agentUserId, owner).getTerminalId();
            if (target == null || !nodes.isTerminalOnline(target)) throw new BizException(AgentError.AGENT_OFFLINE);
            Map<String, Object> command = new LinkedHashMap<>();
            command.put("requestId", requestId);
            command.put("agentUserId", agentUserId);
            command.put("action", action);
            if (modelId != null) command.put("modelId", modelId);
            command.put("requesterTerminalId", source);
            command.put("expiresAt", System.currentTimeMillis() + EXPIRES_MS);
            nodes.send(target, NodeFrame.of(FrameType.AGENT_MODEL_REQUEST, command));
        } catch (BizException error) {
            nodes.send(source, NodeFrame.of(FrameType.AGENT_MODEL_RESULT,
                    Map.of("requestId", requestId, "agentUserId", agentUserId, "error", error.getError().code())));
        }
    }

    public void result(String owner, String source, JsonNode payload) {
        String requestId = text(payload, "requestId");
        String agentUserId = text(payload, "agentUserId");
        String recipient = text(payload, "requesterTerminalId");
        requireIds(requestId, agentUserId);
        if (!source.equals(agents.requireOwnedAgent(agentUserId, owner).getTerminalId())) {
            throw new BizException(AgentError.NOT_ON_THIS_NODE);
        }
        var recipientTerminal = terminals.findByTerminalId(recipient);
        if (recipientTerminal == null || !owner.equals(recipientTerminal.getOwner())) {
            throw new BizException(AgentError.NOT_AGENT_OWNER);
        }
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("requestId", requestId);
        reply.put("agentUserId", agentUserId);
        reply.put("ok", payload.path("ok").isBoolean() && payload.path("ok").asBoolean());
        if (payload.path("catalog").isObject()) reply.put("catalog", payload.path("catalog"));
        String message = text(payload, "message");
        if (!message.isBlank()) reply.put("message", message.length() > MAX_MESSAGE ? message.substring(0, MAX_MESSAGE) : message);
        nodes.send(recipient, NodeFrame.of(FrameType.AGENT_MODEL_RESULT, reply));
    }

    private static String text(JsonNode value, String key) { return value.path(key).asText(""); }

    private static void requireIds(String requestId, String agentUserId) {
        if (requestId.isBlank() || requestId.length() > 100 || agentUserId.isBlank() || agentUserId.length() > 64) {
            throw new BizException(CommonError.BAD_REQUEST);
        }
    }
}
