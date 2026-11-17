package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.dal.mapper.*;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.manager.*;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import java.util.*;

/** MQTT is the only terminal transport. Pushes are hints; durable data is recovered by after_seq and refetching. */
@lombok.extern.slf4j.Slf4j
@Component
public class TerminalNodeRegistry implements NodeRegistry {
    private final TerminalMapper terminals;
    private final UserMapper users;
    private final MqttBridge mqtt;
    private final MqttRoutes routes;
    private final MqttPresence presence;
    public TerminalNodeRegistry(TerminalMapper terminals, UserMapper users,
            MqttBridge mqtt, MqttRoutes routes, MqttPresence presence) {
        this.terminals = terminals; this.users = users;
        this.mqtt = mqtt; this.routes = routes; this.presence = presence;
    }
    public boolean isOnline(String userId) {
        String terminal = users.findTerminalIdOfAgent(userId);
        return terminal != null && isTerminalOnline(terminal);
    }
    public boolean isTerminalOnline(String id) {
        var terminal = terminals.findByTerminalId(id);
        if (terminal == null || TerminalEntity.STATUS_DISABLED.equals(terminal.getStatus())) return false;
        if (!mqtt.enabled()) return false;
        // A failed broker query is unknown, not offline. Callers get a business error instead of HTTP 500 or silence.
        try { return presence.online(id); }
        catch (IllegalStateException unavailable) { throw new PresenceUnknownException(unavailable); }
    }
    public void send(String id, NodeFrame frame) {
        if (id == null) return;
        publish(routes.terminal(id), frame);
    }
    public void sendToUser(String userId, NodeFrame frame) {
        String executionTerminal = users.findTerminalIdOfAgent(userId);
        if (executionTerminal != null) send(executionTerminal, frame);
        else broadcast(List.of(userId), frame);
    }
    /**
     * One batched lookup instead of one query per member: MessageWriter calls this while it still holds the
     * conversation row lock, so a per-member loop would serialise group sends for longer as the group grows.
     */
    public void broadcast(Collection<String> userIds, NodeFrame frame) {
        if (!mqtt.enabled() || userIds.isEmpty()) return;
        Map<String, UserEntity> byId = new HashMap<>();
        for (var user : users.findByUserIds(new ArrayList<>(new LinkedHashSet<>(userIds)))) byId.put(user.getUserId(), user);
        Set<String> owners = new LinkedHashSet<>();
        for (String userId : userIds) {
            var user = byId.get(userId);
            if (user == null) continue;
            // Account events fan out to every member's account, including owners of agent members.
            owners.add(Boolean.TRUE.equals(user.getIsAgent()) ? user.getOwner() : userId);
        }
        for (String owner : owners) if (owner != null) publish(routes.user(owner), frame);
    }
    private void publish(String topic, NodeFrame frame) {
        if (!mqtt.enabled()) return;
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                public void afterCommit() { publishNow(topic, frame); }
            });
        } else publishNow(topic, frame);
    }
    /**
     * A lost hint must not fail the caller: not a saved message (HTTP 500), not a report being processed
     * (which would be redelivered and repeat its side effects). Receivers recover by after_seq and busy re-reports.
     */
    private void publishNow(String topic, NodeFrame frame) {
        try { mqtt.publish(topic, frame); }
        catch (IllegalStateException unavailable) {
            log.warn("MQTT notification dropped topic={} type={} reason={}", topic, frame.type(), MqttBridge.describe(unavailable));
        }
    }
}
