package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.manager.*;
import com.politeness.ading.conductor.service.*;
import com.politeness.ading.conductor.common.BizException;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.util.*;

/** Broker ACL authenticates the report topic; all business identities are still checked here. */
@Slf4j
@Component
public class MqttReportProcessor {
    static final int MAX_REPORT_BYTES = 128 * 1024;
    private final TerminalMapper terminals;
    private final AgentService agents;
    private final ConversationService conversations;
    private final ConversationControlService controls;
    private final AgentModelRelayService agentModels;
    private final TurnActivityBoard activities;
    private final NodeRegistry nodes;
    private final MqttRoutes routes;
    private final ObjectMapper json;
    public MqttReportProcessor(TerminalMapper terminals, AgentService agents, ConversationService conversations,
            ConversationControlService controls, AgentModelRelayService agentModels, TurnActivityBoard activities, NodeRegistry nodes, MqttRoutes routes,
            ObjectMapper json) {
        this.terminals = terminals; this.agents = agents; this.conversations = conversations;
        this.controls = controls; this.agentModels = agentModels; this.activities = activities; this.nodes = nodes; this.routes = routes; this.json = json;
    }
    /**
     * Shared by both report transports, which acknowledge afterwards whatever happens here.
     * A failed report is not redelivered: it may already have recorded activity or fanned out, and every
     * report type is transient (busy is re-reported every 10 seconds; control requests expire in 30 seconds).
     */
    public void handle(String topic, byte[] body) {
        try {
            if (body.length > MAX_REPORT_BYTES) throw new IllegalArgumentException("Report too large");
            accept(topic, json.readTree(body));
        } catch (BizException | IllegalArgumentException | JacksonException rejected) {
            log.warn("Rejected MQTT report topic={} reason={}", topic, MqttBridge.describe(rejected));
        } catch (RuntimeException failed) {
            log.warn("MQTT report dropped after processing failure topic={} reason={}", topic, MqttBridge.describe(failed));
        }
    }
    public void accept(String topic, JsonNode frame) {
        String prefix = routes.reportRoot() + "/";
        if (!topic.startsWith(prefix)) throw new IllegalArgumentException("Wrong report environment");
        String id = MqttRoutes.segment(topic.substring(prefix.length()));
        var terminal = terminals.findByTerminalId(id);
        if (terminal == null || TerminalEntity.STATUS_DISABLED.equals(terminal.getStatus()))
            throw new IllegalArgumentException("Unknown or disabled terminal");
        JsonNode payload = frame.path("payload");
        String type = frame.path("type").asText("");
        switch (type) {
            case "TURN_PROGRESS" -> {
                NodeService.requireExecution(terminal);
                String conversationId = payload.path("conversationId").asText("");
                String agentId = payload.path("agentUserId").asText("");
                agents.requireOwnedAgent(agentId, terminal.getOwner());
                agents.assertAgentOnNode(id, agentId);
                conversations.requireMember(conversationId, agentId);
                Boolean busy = payload.path("busy").isBoolean() ? payload.path("busy").asBoolean() : null;
                String text = payload.path("text").asText("");
                if (text.length() > 8192) text = text.substring(0, 8192);
                List<String> members = conversations.viewerIds(conversationId);
                activities.record(terminal.getOwner(), conversationId, agentId, busy, text);
                Map<String, Object> body = new LinkedHashMap<>();
                body.put("conversationId", conversationId); body.put("agentUserId", agentId);
                body.put("terminalId", id);
                // Preserve source ordering across processing instances and redelivery.
                if (frame.path("sentAt").isNumber()) body.put("sentAt", frame.path("sentAt").asLong());
                if (frame.path("eventId").isTextual()) body.put("eventId", frame.path("eventId").asText());
                if (busy != null) body.put("busy", busy);
                if (!text.isBlank()) body.put("text", text);
                nodes.broadcast(members, NodeFrame.of(FrameType.TURN_PROGRESS, body));
            }
            case "CONVERSATION_CONTROL" -> controls.request(terminal.getOwner(), id, payload);
            case "CONVERSATION_CONTROL_RESULT" -> {
                // Only the executing computer reports control results; a phone may request control but not answer it.
                NodeService.requireExecution(terminal);
                controls.result(terminal.getOwner(), id, payload);
            }
            case "AGENT_MODEL_REQUEST" -> {
                NodeService.requireExecution(terminal);
                agentModels.request(terminal.getOwner(), id, payload);
            }
            case "AGENT_MODEL_RESULT" -> {
                NodeService.requireExecution(terminal);
                agentModels.result(terminal.getOwner(), id, payload);
            }
            default -> throw new IllegalArgumentException("Unsupported report type");
        }
    }
}
