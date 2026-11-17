package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.manager.*;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import lombok.extern.slf4j.Slf4j;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * No application heartbeat: the broker owns connection liveness. TerminalSessionTracker records what this poll
 * observed, for the ops console, which has no broker access. Nothing here reads it back.
 */
@Slf4j @Component
public class MqttPresence {
    private record Entry(boolean online, long checkedAt) {}
    private final Map<String, Boolean> announced = new ConcurrentHashMap<>();
    private final Map<String, Entry> cache = new ConcurrentHashMap<>();
    private final MqttCloud cloud;
    private final MqttRoutes routes;
    private final TerminalMapper terminals;
    private final ObjectProvider<NodeRegistry> nodes;
    private final MqttBridge bridge;
    private final AdingProperties.Mqtt config;
    public MqttPresence(MqttCloud cloud, MqttRoutes routes, TerminalMapper terminals,
            ObjectProvider<NodeRegistry> nodes, MqttBridge bridge, AdingProperties properties,
            TerminalSessionTracker sessions) {
        this(cloud, routes, terminals, nodes, bridge, properties, null, sessions);
    }
    @org.springframework.beans.factory.annotation.Autowired
    public MqttPresence(MqttCloud cloud, MqttRoutes routes, TerminalMapper terminals,
                        ObjectProvider<NodeRegistry> nodes, MqttBridge bridge, AdingProperties properties,
                        com.politeness.ading.conductor.service.AgentShareAudience shareAudience,
                        TerminalSessionTracker sessions) {
        this.sessions = sessions;
        this.cloud = cloud; this.routes = routes; this.terminals = terminals;
        this.nodes = nodes; this.bridge = bridge; this.config = properties.getMqtt(); this.shareAudience = shareAudience;
    }
    private final com.politeness.ading.conductor.service.AgentShareAudience shareAudience;
    private final TerminalSessionTracker sessions;

    /** Throws IllegalStateException when the broker cannot be queried; the state is then unknown. */
    public synchronized boolean online(String id) {
        Entry previous = cache.get(id);
        if (previous != null && System.currentTimeMillis() - previous.checkedAt() < 5000) return previous.online();
        boolean online = cloud.online(routes.clientId(id));
        cache.put(id, new Entry(online, System.currentTimeMillis()));
        return online;
    }
    /**
     * Refresh known devices and invalidate account views when their broker connection changes.
     * Waits for the delivery connection, otherwise every change found at startup is a failed publish.
     * The first observation after a restart is only a baseline: a backend restart does not change any terminal's
     * broker connection, and announcing every terminal would only make every account refetch at once.
     */
    @Scheduled(scheduler = "mqttScheduler", fixedDelay = 15000)
    public void refresh() {
        if (!config.isEnabled() || !bridge.connected()) return;
        var open = sessions.begin();
        var polled = new java.util.HashSet<String>();
        for (var terminal : terminals.findForPresence()) {
            String id = terminal.getTerminalId();
            polled.add(id);
            try {
                boolean current = online(id);
                Boolean previous = announced.put(id, current);
                var observedAt = java.time.LocalDateTime.now();
                if (current) sessions.online(terminal, open, observedAt);
                else sessions.offline(terminal, Boolean.TRUE.equals(previous), open, observedAt);
                if (previous == null || previous == current) continue;
                if (shareAudience != null) shareAudience.changed(terminal.getOwner());
                else nodes.getObject().sendToUser(terminal.getOwner(), NodeFrame.of(FrameType.AGENTS_CHANGED, Map.of()));
            } catch (Exception error) {
                log.warn("MQTT presence refresh failed terminalId={} reason={}", id, MqttBridge.describe(error));
            }
        }
        sessions.finish(open, polled, java.time.LocalDateTime.now());
    }
}
