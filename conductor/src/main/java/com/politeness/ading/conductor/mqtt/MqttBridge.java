package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.manager.NodeFrame;
import jakarta.annotation.PreDestroy;
import org.eclipse.paho.client.mqttv3.*;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/**
 * One delivery connection per backend instance; same-environment workers share one report subscription.
 * Report processing fans out through the delivery connection, so the report consumer starts only after it is up.
 */
@Slf4j
@Component
public class MqttBridge {
    private final AdingProperties.Mqtt config;
    private final MqttRoutes routes;
    private final MqttCloud cloud;
    private final ObjectMapper json;
    private final ObjectProvider<MqttReportProcessor> reports;
    private final MqttCloudReports cloudReports;
    private volatile MqttClient client;
    private long expiresAt;
    // Never publish QoS 1 synchronously on Paho's inbound callback thread.
    private final java.util.concurrent.ThreadPoolExecutor reportExecutor = new java.util.concurrent.ThreadPoolExecutor(
            1, 1, 0L, java.util.concurrent.TimeUnit.MILLISECONDS,
            new java.util.concurrent.ArrayBlockingQueue<>(256), runnable -> {
                Thread thread = new Thread(runnable, "mqtt-reports"); thread.setDaemon(true); return thread;
            }, new java.util.concurrent.ThreadPoolExecutor.AbortPolicy());
    public MqttBridge(AdingProperties properties, MqttRoutes routes, MqttCloud cloud, ObjectMapper json,
            ObjectProvider<MqttReportProcessor> reports, MqttCloudReports cloudReports) {
        this.config = properties.getMqtt(); this.routes = routes; this.cloud = cloud; this.json = json; this.reports = reports; this.cloudReports = cloudReports;
        // MQTT is the only terminal transport. Disabled only for local runs without a broker.
        if (!config.isEnabled()) log.warn("MQTT disabled: terminals get no realtime push and every terminal reports offline");
    }
    protected MqttClient newClient(String brokerUrl, String clientId) throws MqttException {
        return new MqttClient(brokerUrl, clientId, new MemoryPersistence());
    }
    public boolean enabled() { return config.isEnabled(); }
    public boolean connected() {
        MqttClient active = client;
        return active != null && active.isConnected();
    }
    @Scheduled(scheduler = "mqttScheduler", fixedDelay = 10000)
    public synchronized void maintain() {
        if (!enabled()) return;
        boolean nativeCloud = "cloud".equals(config.getReportTransport());
        try {
            if (config.getBrokerUrl() == null || !config.getBrokerUrl().startsWith("ssl://"))
                throw new IllegalStateException("MQTT backend TLS endpoint must be configured");
            if (!nativeCloud && !"mqtt".equals(config.getReportTransport())) throw new IllegalStateException("Invalid MQTT report transport");
            connectDelivery(nativeCloud);
        } catch (Exception error) {
            // A renewal failure keeps the current connection; it remains usable until its token expires.
            log.warn("MQTT backend connection failed; retry scheduled reason={}", describe(error));
        }
        // Started after delivery and never stopped here: renewals and delivery outages must not drop the consumer.
        if (nativeCloud && connected()) {
            try { cloudReports.start(); }
            catch (Exception error) { log.warn("MQTT cloud report consumer failed; retry scheduled reason={}", describe(error)); }
        }
    }
    /** Renewal connects the replacement first, then swaps, so publishing never sees a gap. */
    private void connectDelivery(boolean nativeCloud) throws MqttException {
        if (connected() && expiresAt > System.currentTimeMillis() + 120_000) return;
        long renewedUntil = System.currentTimeMillis() + Math.max(300, Math.min(config.getTokenTtlSeconds(), 86400)) * 1000L;
        String read = nativeCloud ? null : cloud.token(routes.reportRoot() + "/+", "R", renewedUntil);
        String write = cloud.token(routes.deliverRoot() + "/#", "W", renewedUntil);
        // A distinct client ID per connection: reusing it would make the broker drop the old one mid-publish.
        MqttClient connection = newClient(config.getBrokerUrl(), routes.serverGroup() + "@@@" + UUID.randomUUID());
        try {
            connection.setManualAcks(true);
            connection.setCallback(new MqttCallback() {
                public void connectionLost(Throwable cause) {
                    if (connection == client) log.warn("MQTT backend disconnected; reconnect scheduled reason={}", describe(cause));
                }
                public void deliveryComplete(IMqttDeliveryToken token) {}
                public void messageArrived(String topic, MqttMessage message) {
                    // Enqueue only; the callback must return before report processing publishes a response.
                    // A full queue throws, so Paho disconnects without acknowledging unprocessed reports.
                    reportExecutor.execute(() -> processReport(connection, topic, message));
                }
            });
            MqttConnectOptions options = new MqttConnectOptions();
            options.setMqttVersion(MqttConnectOptions.MQTT_VERSION_3_1_1);
            options.setUserName("Token|" + config.getAccessKeyId() + "|" + config.getInstanceId());
            options.setPassword((nativeCloud ? "W|" + write : "R|" + read + "|W|" + write).toCharArray());
            options.setCleanSession(true); options.setKeepAliveInterval(config.getKeepAliveSeconds());
            options.setConnectionTimeout(10); connection.setTimeToWait(10000);
            connection.connect(options);
            if (!nativeCloud) {
                String filter = routes.reportRoot() + "/+";
                if (config.isSharedSubscription()) filter = "$share/" + routes.serverGroup() + "/" + filter;
                connection.subscribe(filter, 1);
            }
        } catch (MqttException | RuntimeException failure) { closeQuietly(connection); throw failure; }
        MqttClient previous = client;
        client = connection; expiresAt = renewedUntil;
        closeQuietly(previous);
        log.info("MQTT backend connected environment={} reportTransport={} renewal={}", routes.environment(), config.getReportTransport(), previous != null);
    }
    /** Processing settles every report; acknowledgement only fails when the connection itself is gone. */
    private void processReport(MqttClient connection, String topic, MqttMessage message) {
        reports.getObject().handle(topic, message.getPayload());
        if (message.getQos() == 0) return;
        try { connection.messageArrivedComplete(message.getId(), message.getQos()); }
        catch (MqttException error) { log.warn("MQTT report acknowledgement failed topic={} reason={}", topic, describe(error)); }
    }
    public void publish(String topic, NodeFrame frame) {
        if (!enabled()) return;
        MqttClient active = client;
        if (active == null || !active.isConnected()) throw new IllegalStateException("MQTT backend is disconnected");
        try { active.publish(topic, json.writeValueAsString(frame).getBytes(StandardCharsets.UTF_8), 1, false); }
        catch (MqttException error) { throw new IllegalStateException("MQTT publish failed", error); }
    }
    public synchronized void close() {
        MqttClient previous = client;
        client = null;
        closeQuietly(previous);
    }
    private static void closeQuietly(MqttClient connection) {
        if (connection == null) return;
        try { if (connection.isConnected()) connection.disconnect(); } catch (Exception ignored) {}
        try { connection.close(); } catch (Exception ignored) {}
    }
    /** Exception messages here name the failed step only (no credentials), so they are safe to log. */
    static String describe(Throwable error) {
        if (error == null) return "unknown";
        String text = error.getClass().getSimpleName() + ": " + error.getMessage();
        Throwable cause = error.getCause();
        return cause == null || cause == error ? text : text + " (cause " + cause.getClass().getSimpleName() + ": " + cause.getMessage() + ")";
    }
    @PreDestroy public void shutdown() {
        close();
        reportExecutor.shutdownNow();
    }

}
