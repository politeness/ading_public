package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import org.springframework.stereotype.Service;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class MqttCredentialsService {
    /** A shared DTO for desktop and iOS; expiresAt is epoch milliseconds. */
    public record Credentials(boolean enabled, String terminalId, String brokerUrl, String clientId,
            String username, String password, List<String> subscriptions, String reportTopic,
            long expiresAt, int keepAliveSeconds) {}
    private final AdingProperties.Mqtt config;
    private final MqttRoutes routes;
    private final MqttCloud cloud;
    private final ConcurrentHashMap<String, Credentials> cache = new ConcurrentHashMap<>();
    public MqttCredentialsService(AdingProperties properties, MqttRoutes routes, MqttCloud cloud) {
        this.config = properties.getMqtt(); this.routes = routes; this.cloud = cloud;
    }
    public synchronized Credentials issue(TerminalEntity terminal) {
        String id = terminal.getTerminalId();
        if (!config.isEnabled()) return new Credentials(false, id, null, null, null, null, List.of(), null, 0, 0);
        Credentials previous = cache.get(id);
        if (previous != null && previous.expiresAt() > System.currentTimeMillis() + 120_000) return previous;
        if (config.getPublicBrokerUrl() == null || !config.getPublicBrokerUrl().startsWith("mqtts://"))
            throw new IllegalStateException("MQTT public TLS endpoint must be configured");
        List<String> topics = List.of(routes.user(terminal.getOwner()), routes.terminal(id));
        long expiresAt = System.currentTimeMillis() + Math.max(300, Math.min(config.getTokenTtlSeconds(), 86400)) * 1000L;
        String read = cloud.token(topics.stream().sorted().collect(java.util.stream.Collectors.joining(",")), "R", expiresAt);
        String write = cloud.token(routes.report(id), "W", expiresAt);
        Credentials credentials = new Credentials(true, id, config.getPublicBrokerUrl(), routes.clientId(id),
                "Token|" + config.getAccessKeyId() + "|" + config.getInstanceId(), "R|" + read + "|W|" + write,
                topics, routes.report(id), expiresAt, config.getKeepAliveSeconds());
        cache.entrySet().removeIf(e -> e.getValue().expiresAt() < System.currentTimeMillis());
        cache.put(id, credentials);
        return credentials;
    }
}
