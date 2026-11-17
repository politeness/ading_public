package com.politeness.ading.conductor.mqtt;

import com.alibaba.mqtt.server.config.ChannelConfig;
import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.GlobalExceptionHandler;
import com.politeness.ading.conductor.dal.entity.*;
import com.politeness.ading.conductor.dal.mapper.*;
import com.politeness.ading.conductor.manager.*;
import com.politeness.ading.conductor.service.*;
import com.rabbitmq.client.*;
import com.rabbitmq.client.impl.LongStringHelper;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import tools.jackson.databind.ObjectMapper;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

/**
 * Regressions for the pre-release startup failure: reports consumed before the delivery connection existed,
 * a failed fan-out treated as an infrastructure failure (nack + abort of the shared channel, then basicNack on a
 * closed channel), and failed presence queries surfacing as HTTP 500 or a missing control receipt.
 */
class MqttFailureIsolationTest {
    final ObjectMapper json = new ObjectMapper();
    final AdingProperties config = new AdingProperties();
    final MqttRoutes routes = new MqttRoutes(config, new MockEnvironment());
    final TerminalMapper terminals = mock(TerminalMapper.class);
    final UserMapper users = mock(UserMapper.class);
    final MqttBridge bridge = mock(MqttBridge.class);
    final MqttPresence presence = mock(MqttPresence.class);
    final TerminalNodeRegistry registry = new TerminalNodeRegistry(terminals, users, bridge, routes, presence);

    MqttFailureIsolationTest() {
        when(bridge.enabled()).thenReturn(true);
        for (String id : List.of("caller", "remote")) {
            var terminal = new TerminalEntity(); terminal.setTerminalId(id); terminal.setOwner("owner"); terminal.setType("DESKTOP");
            when(terminals.findByTerminalId(id)).thenReturn(terminal);
        }
        var agent = user("agent", true); agent.setOwner("owner"); agent.setTerminalId("remote");
        var owner = user("owner", false);
        when(users.findByUserId("agent")).thenReturn(agent);
        when(users.findByUserId("owner")).thenReturn(owner);
        when(users.findByUserIds(org.mockito.ArgumentMatchers.anyList())).thenReturn(List.of(agent, owner));
        when(users.findTerminalIdOfAgent("agent")).thenReturn("remote");
    }
    static UserEntity user(String id, boolean agent) {
        var user = new UserEntity(); user.setUserId(id); user.setIsAgent(agent); return user;
    }

    @Test void failedPresenceQueryIsAnUnknownBusinessErrorNotAnInfrastructureFailure() {
        when(presence.online("remote")).thenThrow(new IllegalStateException("MQTT OpenAPI QuerySessionByClientId failed"));
        var unknown = assertThrows(PresenceUnknownException.class, () -> registry.isTerminalOnline("remote"));
        assertEquals("NODE_006", unknown.getError().code());
        assertInstanceOf(IllegalStateException.class, unknown.getCause());
    }

    @Test void controlRequestWithUnknownPresenceGetsAnErrorReceiptInsteadOfTimingOut() {
        when(presence.online("remote")).thenThrow(new IllegalStateException("MQTT OpenAPI QuerySessionByClientId failed"));
        var conversations = mock(ConversationService.class);
        var agent = user("agent", true); agent.setOwner("owner"); agent.setTerminalId("remote");
        when(conversations.memberUsers("task")).thenReturn(List.of(agent));
        var controls = new ConversationControlService(conversations, terminals, registry);
        assertDoesNotThrow(() -> controls.request("owner", "caller",
                json.readTree("{\"requestId\":\"r\",\"conversationId\":\"task\",\"action\":\"pause\"}")));
        var frame = ArgumentCaptor.forClass(NodeFrame.class);
        verify(bridge).publish(eq("deliver_dev/terminal/caller"), frame.capture());
        assertEquals(FrameType.CONVERSATION_CONTROL_ACCEPTED, frame.getValue().type());
        assertEquals("NODE_006", json.valueToTree(frame.getValue().payload()).path("error").asText());
        verify(bridge, never()).publish(eq("deliver_dev/terminal/remote"), any());
    }

    @Test void statusRefreshWithUnknownPresenceIsAClientVisibleErrorNot500() {
        when(presence.online("remote")).thenThrow(new IllegalStateException("MQTT OpenAPI QuerySessionByClientId failed"));
        var agent = user("agent", true); agent.setOwner("owner"); agent.setTerminalId("remote");
        var agentUsers = mock(UserMapper.class); when(agentUsers.findByUserId("agent")).thenReturn(agent);
        var agents = new AgentService(agentUsers, mock(AgentSessionMapper.class), mock(RelationService.class), registry, new IdGenerator());
        var error = assertThrows(BizException.class, () -> agents.requestStatusRefresh("agent", "owner"));
        var response = new GlobalExceptionHandler().handleBiz(error, new MockHttpServletRequest("POST", "/api/v1/agents/agent/verify"));
        assertEquals(400, response.getStatusCode().value());
        assertEquals("NODE_006", response.getBody().code());
        verify(bridge, never()).publish(anyString(), any());
    }

    @Test void contactsStillShowUnknownWhenPresenceQueryFails() {
        when(presence.online("remote")).thenThrow(new IllegalStateException("query unavailable"));
        var agent = user("agent", true); agent.setOwner("owner"); agent.setTerminalId("remote");
        var view = new AgentStateService(users, terminals, registry).describe(agent);
        assertNull(view.computerOnline());
        assertEquals("remote", view.computerId());
    }

    @Test void disconnectedDeliveryDoesNotFailANonTransactionalRequest() {
        when(presence.online("remote")).thenReturn(true);
        doThrow(new IllegalStateException("MQTT backend is disconnected")).when(bridge).publish(anyString(), any());
        var agent = user("agent", true); agent.setOwner("owner"); agent.setTerminalId("remote");
        var agentUsers = mock(UserMapper.class); when(agentUsers.findByUserId("agent")).thenReturn(agent);
        when(agentUsers.findTerminalIdOfAgent("agent")).thenReturn("remote");
        var agents = new AgentService(agentUsers, mock(AgentSessionMapper.class), mock(RelationService.class),
                new TerminalNodeRegistry(terminals, agentUsers, bridge, routes, presence), new IdGenerator());
        assertDoesNotThrow(() -> agents.requestStatusRefresh("agent", "owner"));
        verify(bridge).publish(eq("deliver_dev/terminal/remote"), argThat(f -> f.type() == FrameType.AGENT_VERIFY_REQUEST));
    }

    /** The exact pre-release sequence: prefetched reports arrive while delivery publishing is unavailable. */
    @SuppressWarnings("unchecked")
    @Test void reportsWithFailedFanoutAreEachAcknowledgedOnceAndNeverAbortTheSharedChannel() throws Exception {
        doThrow(new IllegalStateException("MQTT backend is disconnected")).when(bridge).publish(anyString(), any());
        var agents = mock(AgentService.class); var conversations = mock(ConversationService.class);
        when(conversations.viewerIds("task")).thenReturn(List.of("owner", "agent"));
        var board = new TurnActivityBoard();
        var processor = new MqttReportProcessor(terminals, agents, conversations, mock(ConversationControlService.class), mock(AgentModelRelayService.class),
                board, registry, routes, json);
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(processor);
        var connection = mock(Connection.class); var channel = mock(Channel.class);
        when(connection.createChannel()).thenReturn(channel); when(channel.isOpen()).thenReturn(true);
        var receiver = new MqttCloudReports(config, routes, provider) {
            @Override protected Connection openConnection(ChannelConfig settings) { return connection; }
        };
        try {
            receiver.start();
            var consumer = ArgumentCaptor.forClass(Consumer.class);
            verify(channel).basicConsume(eq("report_dev"), eq(false), consumer.capture());
            var metadata = new AMQP.BasicProperties.Builder().headers(Map.of("mqttSecondTopic", LongStringHelper.asLongString("/remote"))).build();
            byte[] busy = "{\"type\":\"TURN_PROGRESS\",\"payload\":{\"conversationId\":\"task\",\"agentUserId\":\"agent\",\"busy\":true,\"text\":\"line\"}}".getBytes();
            consumer.getValue().handleDelivery("tag", new Envelope(1, false, "", ""), metadata, busy);
            consumer.getValue().handleDelivery("tag", new Envelope(2, false, "", ""), metadata, busy);
            verify(channel).basicAck(1, false); verify(channel).basicAck(2, false);
            verify(channel, never()).basicNack(anyLong(), anyBoolean(), anyBoolean());
            verify(channel, never()).abort();
            // Fan-out was attempted for both and the activity snapshot still serves polling phones.
            verify(bridge, times(2)).publish(eq("deliver_dev/user/owner"), any());
            assertEquals(List.of("line", "line"), board.linesOf(board.activeFor("owner").getFirst()));
        } finally { receiver.shutdown(); }
    }

    @SuppressWarnings("unchecked")
    @Test void closedChannelIsNotAcknowledgedOnAndAckFailuresStayInsideTheConsumer() throws Exception {
        var processor = mock(MqttReportProcessor.class);
        var provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(processor);
        var connection = mock(Connection.class); var channel = mock(Channel.class);
        when(connection.createChannel()).thenReturn(channel);
        var receiver = new MqttCloudReports(config, routes, provider) {
            @Override protected Connection openConnection(ChannelConfig settings) { return connection; }
        };
        try {
            receiver.start();
            var consumer = ArgumentCaptor.forClass(Consumer.class);
            verify(channel).basicConsume(eq("report_dev"), eq(false), consumer.capture());
            var metadata = new AMQP.BasicProperties.Builder().headers(Map.of("mqttSecondTopic", LongStringHelper.asLongString("/remote"))).build();
            when(channel.isOpen()).thenReturn(false);
            assertDoesNotThrow(() -> consumer.getValue().handleDelivery("tag", new Envelope(3, false, "", ""), metadata, "{}".getBytes()));
            verify(channel, never()).basicAck(anyLong(), anyBoolean());
            verify(channel, never()).basicNack(anyLong(), anyBoolean(), anyBoolean());
            when(channel.isOpen()).thenReturn(true);
            doThrow(new AlreadyClosedException(new ShutdownSignalException(false, false, null, channel))).when(channel).basicAck(4, false);
            assertDoesNotThrow(() -> consumer.getValue().handleDelivery("tag", new Envelope(4, false, "", ""), metadata, "{}".getBytes()));
            verify(processor, times(2)).handle(eq("report_dev/remote"), any());
        } finally { receiver.shutdown(); }
    }

    @Test void unexpectedProcessingFailureIsLoggedNotThrownToTheTransport() {
        var conversations = mock(ConversationService.class);
        when(conversations.viewerIds("task")).thenThrow(new IllegalStateException("database unavailable"));
        var processor = new MqttReportProcessor(terminals, mock(AgentService.class), conversations,
                mock(ConversationControlService.class), mock(AgentModelRelayService.class), new TurnActivityBoard(), registry, routes, json);
        byte[] busy = "{\"type\":\"TURN_PROGRESS\",\"payload\":{\"conversationId\":\"task\",\"agentUserId\":\"agent\",\"busy\":true}}".getBytes();
        assertDoesNotThrow(() -> processor.handle("report_dev/remote", busy));
        assertDoesNotThrow(() -> processor.handle("report_dev/remote", "not json".getBytes()));
        assertDoesNotThrow(() -> processor.handle("report_dev/remote", new byte[MqttReportProcessor.MAX_REPORT_BYTES + 1]));
        verify(bridge, never()).publish(anyString(), any());
    }

    @Test void reportConsumerStartsOnlyAfterTheDeliveryConnectionIsUp() throws Exception {
        var settings = new AdingProperties(); var mqtt = settings.getMqtt();
        mqtt.setEnabled(true); mqtt.setBrokerUrl("ssl://localhost:8883");
        var cloud = mock(MqttCloud.class); var reports = mock(MqttCloudReports.class);
        when(cloud.token(anyString(), anyString(), anyLong())).thenThrow(new IllegalStateException("MQTT OpenAPI ApplyToken failed"));
        var client = mock(MqttClient.class);
        var real = new MqttBridge(settings, new MqttRoutes(settings, new MockEnvironment()), cloud, json, mock(ObjectProvider.class), reports) {
            @Override protected MqttClient newClient(String url, String id) { return client; }
        };
        try {
            real.maintain();
            verify(reports, never()).start();
            assertFalse(real.connected());
            reset(cloud); when(cloud.token(anyString(), anyString(), anyLong())).thenReturn("token");
            doAnswer(call -> { when(client.isConnected()).thenReturn(true); return null; }).when(client).connect(any(MqttConnectOptions.class));
            real.maintain();
            var order = inOrder(client, reports);
            order.verify(client).connect(any(MqttConnectOptions.class));
            order.verify(reports).start();
        } finally { real.shutdown(); }
    }

    @Test void tokenRenewalConnectsTheReplacementBeforeClosingTheOldConnectionAndKeepsTheConsumer() throws Exception {
        var settings = new AdingProperties(); var mqtt = settings.getMqtt();
        mqtt.setEnabled(true); mqtt.setBrokerUrl("ssl://localhost:8883");
        var cloud = mock(MqttCloud.class); when(cloud.token(anyString(), anyString(), anyLong())).thenReturn("token");
        var reports = mock(MqttCloudReports.class);
        var first = mock(MqttClient.class); var second = mock(MqttClient.class);
        for (var client : List.of(first, second))
            doAnswer(call -> { when(client.isConnected()).thenReturn(true); return null; }).when(client).connect(any(MqttConnectOptions.class));
        var clients = new ArrayDeque<>(List.of(first, second)); var ids = new ArrayList<String>();
        var real = new MqttBridge(settings, new MqttRoutes(settings, new MockEnvironment()), cloud, json, mock(ObjectProvider.class), reports) {
            @Override protected MqttClient newClient(String url, String id) { ids.add(id); return clients.removeFirst(); }
        };
        try {
            real.maintain();
            // Simulate the hourly renewal: the first token is inside its 120-second renewal margin.
            var expires = MqttBridge.class.getDeclaredField("expiresAt"); expires.setAccessible(true); expires.setLong(real, 0);
            real.maintain();
            var order = inOrder(first, second);
            order.verify(second).connect(any(MqttConnectOptions.class));
            order.verify(first).disconnect();
            assertNotEquals(ids.get(0), ids.get(1));
            real.publish("deliver_dev/user/owner", NodeFrame.of(FrameType.AGENTS_CHANGED, Map.of()));
            verify(second).publish(eq("deliver_dev/user/owner"), any(byte[].class), eq(1), eq(false));
            verify(first, never()).publish(anyString(), any(byte[].class), anyInt(), anyBoolean());
            verify(reports, never()).close();
            verify(reports, times(2)).start();
        } finally { real.shutdown(); }
    }

    @Test void failedRenewalKeepsTheWorkingConnection() throws Exception {
        var settings = new AdingProperties(); var mqtt = settings.getMqtt();
        mqtt.setEnabled(true); mqtt.setBrokerUrl("ssl://localhost:8883");
        var cloud = mock(MqttCloud.class); when(cloud.token(anyString(), anyString(), anyLong())).thenReturn("token");
        var first = mock(MqttClient.class);
        doAnswer(call -> { when(first.isConnected()).thenReturn(true); return null; }).when(first).connect(any(MqttConnectOptions.class));
        var real = new MqttBridge(settings, new MqttRoutes(settings, new MockEnvironment()), cloud, json, mock(ObjectProvider.class), mock(MqttCloudReports.class)) {
            @Override protected MqttClient newClient(String url, String id) { return first; }
        };
        try {
            real.maintain();
            var expires = MqttBridge.class.getDeclaredField("expiresAt"); expires.setAccessible(true); expires.setLong(real, 0);
            reset(cloud); when(cloud.token(anyString(), anyString(), anyLong())).thenThrow(new IllegalStateException("MQTT OpenAPI ApplyToken failed"));
            real.maintain();
            verify(first, never()).disconnect();
            assertTrue(real.connected());
        } finally { real.shutdown(); }
    }

    private final TerminalSessionTracker sessions = mock(TerminalSessionTracker.class);

    @SuppressWarnings("unchecked")
    @Test void presenceWaitsForDeliveryAndTreatsTheFirstObservationAsABaseline() throws Exception {
        var settings = new AdingProperties(); settings.getMqtt().setEnabled(true);
        var cloud = mock(MqttCloud.class); var nodes = mock(NodeRegistry.class);
        ObjectProvider<NodeRegistry> provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(nodes);
        var terminal = new TerminalEntity(); terminal.setTerminalId("remote"); terminal.setOwner("owner");
        when(terminals.findForPresence()).thenReturn(List.of(terminal));
        var connected = mock(MqttBridge.class);
        var tracker = new MqttPresence(cloud, routes, terminals, provider, connected, settings, sessions);
        tracker.refresh();
        verifyNoInteractions(cloud, nodes);
        when(connected.connected()).thenReturn(true);
        when(cloud.online("GID_TERMINAL_DEV@@@remote")).thenReturn(true);
        tracker.refresh();
        verifyNoInteractions(nodes);
        when(cloud.online("GID_TERMINAL_DEV@@@remote")).thenReturn(false);
        // Skip the 5-second query cache instead of sleeping through it.
        var cache = MqttPresence.class.getDeclaredField("cache"); cache.setAccessible(true); ((Map<?, ?>) cache.get(tracker)).clear();
        tracker.refresh();
        verify(nodes).sendToUser(eq("owner"), argThat(f -> f.type() == FrameType.AGENTS_CHANGED));
    }

    @SuppressWarnings("unchecked")
    @Test void presenceReportsEachObservationToTheSessionTrackerAndAFailedQueryIsNeither() throws Exception {
        var settings = new AdingProperties(); settings.getMqtt().setEnabled(true);
        var cloud = mock(MqttCloud.class);
        ObjectProvider<NodeRegistry> provider = mock(ObjectProvider.class); when(provider.getObject()).thenReturn(mock(NodeRegistry.class));
        var terminal = new TerminalEntity(); terminal.setTerminalId("seen"); terminal.setOwner("owner");
        when(terminals.findForPresence()).thenReturn(List.of(terminal));
        var connected = mock(MqttBridge.class); when(connected.connected()).thenReturn(true);
        var tracker = new MqttPresence(cloud, routes, terminals, provider, connected, settings, sessions);
        var cache = MqttPresence.class.getDeclaredField("cache"); cache.setAccessible(true);
        when(cloud.online("GID_TERMINAL_DEV@@@seen")).thenReturn(false);
        tracker.refresh();
        verify(sessions).offline(eq(terminal), eq(false), any(), any());
        ((Map<?, ?>) cache.get(tracker)).clear();
        when(cloud.online("GID_TERMINAL_DEV@@@seen")).thenReturn(true);
        tracker.refresh();
        verify(sessions).online(eq(terminal), any(), any());
        ((Map<?, ?>) cache.get(tracker)).clear();
        when(cloud.online("GID_TERMINAL_DEV@@@seen")).thenReturn(false);
        tracker.refresh();
        verify(sessions).offline(eq(terminal), eq(true), any(), any());
        ((Map<?, ?>) cache.get(tracker)).clear();
        when(cloud.online("GID_TERMINAL_DEV@@@seen")).thenThrow(new IllegalStateException("broker down"));
        tracker.refresh();
        verify(sessions, times(1)).online(any(), any(), any());
        verify(sessions, times(2)).offline(any(), anyBoolean(), any(), any());
        verify(sessions, times(4)).finish(any(), eq(java.util.Set.of("seen")), any());
    }
}
