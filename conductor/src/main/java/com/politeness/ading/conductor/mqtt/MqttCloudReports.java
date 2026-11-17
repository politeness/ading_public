package com.politeness.ading.conductor.mqtt;

import com.alibaba.mqtt.server.config.ChannelConfig;
import com.alibaba.mqtt.server.network.AbstractChannel;
import com.alibaba.mqtt.server.model.MessageProperties;
import com.rabbitmq.client.*;
import com.politeness.ading.conductor.common.config.AdingProperties;
import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import java.io.IOException;
import java.util.concurrent.*;

/** Managed cloud-SDK receiver. Consumers of the same first-topic queue compete across processes. */
@Slf4j @Component
public class MqttCloudReports {
    private final AdingProperties.Mqtt config;
    private final MqttRoutes routes;
    private final ObjectProvider<MqttReportProcessor> reports;
    private final ExecutorService callbacks = Executors.newFixedThreadPool(2, runnable -> {
        Thread thread = new Thread(runnable, "mqtt-cloud-reports"); thread.setDaemon(true); return thread;
    });
    private Connection connection;
    private volatile Channel channel;
    /** False once the broker cancels our consumer (e.g. the queue is recreated) while the channel itself stays open. */
    private volatile boolean consuming;
    public MqttCloudReports(AdingProperties properties, MqttRoutes routes, ObjectProvider<MqttReportProcessor> reports) {
        this.config = properties.getMqtt(); this.routes = routes; this.reports = reports;
    }
    /** Use the vendor SDK's signing and protocol setup, with explicit ownership of connection lifetimes. */
    private static final class ManagedChannel extends AbstractChannel {
        ManagedChannel(ChannelConfig config) { super(config); }
        Connection open(ExecutorService callbacks) throws IOException, TimeoutException {
            super.start();
            // The bridge's maintenance loop reconnects with fresh signing timestamps.
            factory.setAutomaticRecoveryEnabled(false);
            factory.setSharedExecutor(callbacks);
            return factory.newConnection();
        }
    }
    protected Connection openConnection(ChannelConfig config) throws IOException, TimeoutException {
        return new ManagedChannel(config).open(callbacks);
    }
    public synchronized void start() throws IOException, TimeoutException {
        if (consuming && connection != null && connection.isOpen() && channel != null && channel.isOpen()) return;
        close();
        String domain = config.getCloudDomain();
        if (domain == null || domain.isBlank()) {
            if (!routes.environment().equals("dev")) throw new IllegalStateException("MQTT cloud-domain must be explicitly configured for pre/prod");
            domain = config.getInstanceId() + "-server-internet.mqtt.aliyuncs.com";
        }
        ChannelConfig settings = new ChannelConfig();
        settings.setDomain(domain); settings.setPort(config.getCloudPort());
        settings.setInstanceId(config.getInstanceId()); settings.setAccessKey(config.getAccessKeyId());
        settings.setSecretKey(config.getAccessKeySecret());
        settings.setConnectionTimeout(10000); settings.setHandshakeTimeout(10000); settings.setShutdownTimeout(1000);
        try {
            connection = openConnection(settings);
            channel = connection.createChannel();
            channel.basicQos(16);
            Channel receiving = channel;
            receiving.basicConsume(routes.reportRoot(), false, new DefaultConsumer(receiving) {
                @Override public void handleDelivery(String tag, Envelope envelope, AMQP.BasicProperties properties, byte[] body) {
                    String second = null;
                    try { second = new MessageProperties(properties).getSecondTopic(); }
                    catch (RuntimeException invalid) { log.warn("Rejected MQTT cloud report reason={}", MqttBridge.describe(invalid)); }
                    // Cloud SDK supplies a first topic and a slash-prefixed second topic.
                    if (second != null) reports.getObject().handle(routes.reportRoot() + "/" + second.replaceFirst("^/", ""), body);
                    else log.warn("Rejected MQTT cloud report reason=missing second topic");
                    acknowledge(receiving, envelope.getDeliveryTag());
                }
                /** An open channel with no consumer would silently stop reports; let the next maintain() rebuild it. */
                @Override public void handleCancel(String tag) {
                    if (receiving != channel) return;
                    consuming = false;
                    log.warn("MQTT cloud report consumer cancelled by broker; it is rebuilt on the next maintenance run");
                }
            });
            consuming = true;
            log.info("MQTT cloud report consumer connected environment={} firstTopic={}", routes.environment(), routes.reportRoot());
        } catch (IOException | TimeoutException | RuntimeException failure) { close(); throw failure; }
    }
    /**
     * Every report is settled once, whatever the outcome; one report never closes the channel shared by the others.
     * A channel that is already closed cannot be acknowledged on; the broker redelivers its unacknowledged reports.
     */
    private static void acknowledge(Channel receiving, long tag) {
        if (!receiving.isOpen()) { log.warn("MQTT cloud report left for redelivery: channel closed"); return; }
        try { receiving.basicAck(tag, false); }
        catch (IOException | ShutdownSignalException closed) {
            log.warn("MQTT cloud report acknowledgement failed; left for redelivery reason={}", MqttBridge.describe(closed));
        }
    }
    public synchronized void close() {
        if (connection != null) try { connection.close(1000); } catch (Exception ignored) {}
        consuming = false; channel = null; connection = null;
    }
    @PreDestroy public void shutdown() { close(); callbacks.shutdownNow(); }
}
