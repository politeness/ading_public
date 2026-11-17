package com.politeness.ading.conductor.mqtt;

import com.alibaba.mqtt.server.config.ChannelConfig;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.rabbitmq.client.*;
import com.rabbitmq.client.impl.LongStringHelper;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.mock.env.MockEnvironment;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.mockito.ArgumentCaptor;

class MqttCloudReportsTest {
    @SuppressWarnings("unchecked")
    @Test void consumesOnlyEnvironmentFirstTopicAndAcknowledgesAfterValidatedDispatch() throws Exception {
        var settings = new AdingProperties(); settings.getMqtt().setCloudDomain("explicit-private-endpoint");
        var environment = new MockEnvironment(); environment.setActiveProfiles("pre", "prod");
        var processor = mock(MqttReportProcessor.class);
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(processor);
        var connection = mock(Connection.class); var channel = mock(Channel.class);
        when(connection.createChannel()).thenReturn(channel); when(connection.isOpen()).thenReturn(true); when(channel.isOpen()).thenReturn(true);
        var receiver = new MqttCloudReports(settings, new MqttRoutes(settings, environment), provider) {
            @Override protected Connection openConnection(ChannelConfig config) {
                assertEquals("explicit-private-endpoint", config.getDomain()); assertEquals(5672, config.getPort()); return connection;
            }
        };
        try {
            receiver.start(); receiver.start();
            verify(connection, times(1)).createChannel();
            var consumer = ArgumentCaptor.forClass(Consumer.class);
            verify(channel).basicConsume(eq("report_pre"), eq(false), consumer.capture());
            var metadata = new AMQP.BasicProperties.Builder().headers(Map.of("mqttSecondTopic", LongStringHelper.asLongString("/d_test"))).build();
            consumer.getValue().handleDelivery("tag", new Envelope(42, false, "", ""), metadata, "{\"type\":\"TURN_PROGRESS\"}".getBytes());
            var ordered = inOrder(processor, channel);
            ordered.verify(processor).handle(eq("report_pre/d_test"), any());
            ordered.verify(channel).basicAck(42, false);
        } finally { receiver.shutdown(); }
    }
    @SuppressWarnings("unchecked")
    @Test void reportWithoutSecondTopicIsRejectedAndStillSettled() throws Exception {
        var settings = new AdingProperties(); settings.getMqtt().setCloudDomain("test-endpoint");
        var processor = mock(MqttReportProcessor.class);
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(processor);
        var connection = mock(Connection.class); var channel = mock(Channel.class);
        when(connection.createChannel()).thenReturn(channel); when(channel.isOpen()).thenReturn(true);
        var receiver = new MqttCloudReports(settings, new MqttRoutes(settings, new MockEnvironment()), provider) {
            @Override protected Connection openConnection(ChannelConfig config) { return connection; }
        };
        try {
            receiver.start(); var consumer = ArgumentCaptor.forClass(Consumer.class);
            verify(channel).basicConsume(eq("report_dev"), eq(false), consumer.capture());
            consumer.getValue().handleDelivery("tag", new Envelope(43, false, "", ""), new AMQP.BasicProperties(), "{}".getBytes());
            verifyNoInteractions(processor);
            verify(channel).basicAck(43, false); verify(channel, never()).abort();
        } finally { receiver.shutdown(); }
    }
    @SuppressWarnings("unchecked")
    @Test void brokerCancelledConsumerIsRebuiltOnTheNextStartEvenThoughTheChannelStaysOpen() throws Exception {
        var settings = new AdingProperties(); settings.getMqtt().setCloudDomain("test-endpoint");
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(mock(MqttReportProcessor.class));
        var first = mock(Connection.class); var firstChannel = mock(Channel.class);
        var second = mock(Connection.class); var secondChannel = mock(Channel.class);
        for (var connection : java.util.List.of(first, second)) when(connection.isOpen()).thenReturn(true);
        when(first.createChannel()).thenReturn(firstChannel); when(second.createChannel()).thenReturn(secondChannel);
        when(firstChannel.isOpen()).thenReturn(true); when(secondChannel.isOpen()).thenReturn(true);
        var connections = new java.util.ArrayDeque<>(java.util.List.of(first, second));
        var receiver = new MqttCloudReports(settings, new MqttRoutes(settings, new MockEnvironment()), provider) {
            @Override protected Connection openConnection(ChannelConfig config) { return connections.pop(); }
        };
        try {
            receiver.start();
            var consumer = ArgumentCaptor.forClass(Consumer.class);
            verify(firstChannel).basicConsume(eq("report_dev"), eq(false), consumer.capture());
            receiver.start();
            assertFalse(connections.isEmpty(), "a healthy consumer must not be rebuilt");
            consumer.getValue().handleCancel("tag");
            receiver.start();
            verify(first).close(1000);
            verify(secondChannel).basicConsume(eq("report_dev"), eq(false), any(Consumer.class));
            // A late cancel from the replaced channel must not tear down the new consumer.
            consumer.getValue().handleCancel("tag");
            receiver.start();
            verify(second, never()).close(anyInt());
        } finally { receiver.shutdown(); }
    }
    @SuppressWarnings("unchecked")
    @Test void preProdCannotSilentlyFallBackToAPublicCloudEndpoint() {
        var settings = new AdingProperties(); var environment = new MockEnvironment(); environment.setActiveProfiles("prod");
        var receiver = new MqttCloudReports(settings, new MqttRoutes(settings, environment), mock(ObjectProvider.class));
        try { assertThrows(IllegalStateException.class, receiver::start); } finally { receiver.shutdown(); }
    }
}
