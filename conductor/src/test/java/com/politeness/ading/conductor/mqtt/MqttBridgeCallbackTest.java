package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.common.config.AdingProperties;
import org.eclipse.paho.client.mqttv3.*;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import org.mockito.ArgumentCaptor;

class MqttBridgeCallbackTest {
    @SuppressWarnings("unchecked")
    @Test void inboundCallbackReturnsBeforeProcessingAndAcknowledgesOnlyAfterCompletion() throws Exception {
        var config = new AdingProperties(); var mqtt = config.getMqtt();
        mqtt.setEnabled(true); mqtt.setReportTransport("mqtt"); mqtt.setBrokerUrl("ssl://localhost:8883");
        var cloud = mock(MqttCloud.class); when(cloud.token(anyString(), anyString(), anyLong())).thenReturn("test");
        var processor = mock(MqttReportProcessor.class);
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(processor);
        var connection = mock(MqttClient.class);
        var bridge = new MqttBridge(config, new MqttRoutes(config, new MockEnvironment()), cloud, new ObjectMapper(), provider, mock(MqttCloudReports.class)) {
            @Override protected MqttClient newClient(String url, String id) { return connection; }
        };
        var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
        doAnswer(call -> { entered.countDown(); assertTrue(release.await(5, TimeUnit.SECONDS)); return null; })
                .when(processor).handle(anyString(), any());
        try {
            bridge.maintain();
            verify(connection).setManualAcks(true);
            var callback = ArgumentCaptor.forClass(MqttCallback.class); verify(connection).setCallback(callback.capture());
            var message = new MqttMessage("{\"type\":\"TURN_PROGRESS\"}".getBytes(StandardCharsets.UTF_8));
            message.setId(7); message.setQos(1);
            callback.getValue().messageArrived("report_dev/test", message);
            assertTrue(entered.await(2, TimeUnit.SECONDS));
            verify(connection, never()).messageArrivedComplete(anyInt(), anyInt());
            release.countDown();
            verify(connection, timeout(2000)).messageArrivedComplete(7, 1);
        } finally { release.countDown(); bridge.shutdown(); }
    }
    @SuppressWarnings("unchecked")
    @Test void processedReportIsAcknowledgedWithoutDroppingTheConnection() throws Exception {
        var config = new AdingProperties(); config.getMqtt().setEnabled(true); config.getMqtt().setReportTransport("mqtt"); config.getMqtt().setBrokerUrl("ssl://localhost:8883");
        var cloud = mock(MqttCloud.class); when(cloud.token(anyString(), anyString(), anyLong())).thenReturn("test");
        var processor = mock(MqttReportProcessor.class);
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(processor);
        var connection = mock(MqttClient.class);
        var bridge = new MqttBridge(config, new MqttRoutes(config, new MockEnvironment()), cloud, new ObjectMapper(), provider, mock(MqttCloudReports.class)) {
            @Override protected MqttClient newClient(String url, String id) { return connection; }
        };
        try {
            bridge.maintain();
            var callback = ArgumentCaptor.forClass(MqttCallback.class); verify(connection).setCallback(callback.capture());
            var message = new MqttMessage("{}".getBytes(StandardCharsets.UTF_8)); message.setId(8); message.setQos(1);
            callback.getValue().messageArrived("report_dev/test", message);
            verify(connection, timeout(2000)).messageArrivedComplete(8, 1);
            verify(processor).handle(eq("report_dev/test"), any());
            verify(connection, never()).disconnectForcibly(anyLong(), anyLong(), anyBoolean());
        } finally { bridge.shutdown(); }
    }
}
