package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.common.*;
import com.politeness.ading.conductor.common.auth.*;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.*;
import com.politeness.ading.conductor.dal.entity.*;
import com.politeness.ading.conductor.dal.mapper.*;
import com.politeness.ading.conductor.manager.*;
import com.politeness.ading.conductor.service.*;
import org.junit.jupiter.api.*;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.transaction.support.*;
import tools.jackson.databind.ObjectMapper;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.nio.charset.StandardCharsets;
import java.util.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class MqttContractTest {
    final ObjectMapper json = new ObjectMapper();
    AdingProperties config;
    @BeforeEach void setup() {
        config = new AdingProperties(); config.getAuth().setSecret("compatibility-test-secret-for-unit-tests-only");
    }
    MqttRoutes routes(String... profiles) {
        var env = new MockEnvironment(); env.setActiveProfiles(profiles);
        return new MqttRoutes(config, env);
    }
    TerminalEntity terminal() {
        var t = new TerminalEntity(); t.setTerminalId("d_mac"); t.setOwner("u_owner"); t.setType("DESKTOP"); return t;
    }
    String legacyToken(Map<String, Object> claims) throws Exception {
        var encoder = Base64.getUrlEncoder().withoutPadding();
        var body = new LinkedHashMap<String,Object>(Map.of("sub", "u_owner", "typ", "NODE", "tep", 0,
                "exp", System.currentTimeMillis()/1000 + 300));
        body.putAll(claims);
        String input = encoder.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8))
                + "." + encoder.encodeToString(json.writeValueAsBytes(body));
        Mac signer = Mac.getInstance("HmacSHA256");
        signer.init(new SecretKeySpec(config.getAuth().getSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return input + "." + encoder.encodeToString(signer.doFinal(input.getBytes(StandardCharsets.UTF_8)));
    }
    @Test void tokensRequireTerminalIdAndRejectOldDidTokens() throws Exception {
        var tokens = new TokenService(config, json);
        String fresh = tokens.issueNodeToken("u_owner", "d_mac", 0);
        var payload = json.readTree(Base64.getUrlDecoder().decode(fresh.split("\\.")[1]));
        assertEquals("d_mac", payload.path("terminalId").asText());
        assertFalse(payload.has("did")); assertFalse(payload.has("tid"));
        assertThrows(BizException.class, () -> tokens.parse(legacyToken(Map.of("did", "d_mac"))));
        assertEquals("d_mac", tokens.parse(fresh).terminalId());
        assertThrows(BizException.class, () -> tokens.parse(legacyToken(Map.of())));
    }
    @Test void wireUsesOnlyTerminalId() {
        var encoded = json.readTree(json.writeValueAsString(new NodeRegisterResponse("d_mac", "Home", "secret")));
        assertEquals("d_mac", encoded.path("terminalId").asText());
        var current = json.readValue("{\"name\":\"x\",\"path\":\"/tmp\",\"terminalId\":\"d_mac\"}", WorkspaceCreateRequest.class);
        assertEquals("d_mac", current.terminalId());
    }
    @Test void profilesSeparateReportsAndShareOnlyPreProdDelivery() {
        assertEquals("report_pre", routes("pre", "prod").reportRoot());
        assertEquals("report", routes("prod").reportRoot());
        assertEquals("report_dev", routes("dev").reportRoot());
        assertEquals("deliver/user/u_owner", routes("pre", "prod").user("u_owner"));
        assertEquals(routes("pre").terminal("d_mac"), routes("prod").terminal("d_mac"));
        assertEquals("deliver_dev/user/u_owner", routes("dev").user("u_owner"));
        assertEquals("GID_TERMINAL@@@d_mac", routes("pre").clientId("d_mac"));
        assertEquals("GID_TERMINAL_DEV@@@d_mac", routes("dev").clientId("d_mac"));
        assertEquals("GID_SERVER_PRE", routes("pre").serverGroup());
        assertEquals("GID_SERVER", routes("prod").serverGroup());
        assertEquals("GID_SERVER_DEV", routes("dev").serverGroup());
        assertThrows(IllegalArgumentException.class, () -> routes("prod").terminal("other/#"));
    }
    @Test void credentialsGrantReadOnlyOwnAccountAndTerminalAndWriteOnlyOwnEnvironmentReport() {
        config.getMqtt().setEnabled(true); config.getMqtt().setPublicBrokerUrl("mqtts://example.com:8883");
        config.getMqtt().setAccessKeyId("public-key-id"); config.getMqtt().setInstanceId("instance");
        var cloud = mock(MqttCloud.class);
        when(cloud.token(anyString(), eq("R"), anyLong())).thenReturn("read");
        when(cloud.token(anyString(), eq("W"), anyLong())).thenReturn("write");
        var service = new MqttCredentialsService(config, routes("pre"), cloud);
        var credentials = service.issue(terminal());
        assertEquals(List.of("deliver/user/u_owner", "deliver/terminal/d_mac"), credentials.subscriptions());
        assertEquals("report_pre/d_mac", credentials.reportTopic());
        assertEquals("R|read|W|write", credentials.password());
        verify(cloud).token(eq("deliver/terminal/d_mac,deliver/user/u_owner"), eq("R"), anyLong());
        verify(cloud).token(eq("report_pre/d_mac"), eq("W"), anyLong());
        assertSame(credentials, service.issue(terminal()));
        verifyNoMoreInteractions(cloud);
    }
    @Test void disabledMqttDoesNotRequestCloudTokens() {
        var cloud = mock(MqttCloud.class);
        assertFalse(new MqttCredentialsService(config, routes("dev"), cloud).issue(terminal()).enabled());
        verifyNoInteractions(cloud);
    }
    @Test void connectionQueryUsesRealApiShapeAndDoesNotInterpretFailureAsOffline() {
        var cloud = new MqttCloud(config, json) {
            @Override protected tools.jackson.databind.JsonNode call(String action, Map<String,String> values) {
                assertEquals("QuerySessionByClientId", action);
                assertEquals("GID_TERMINAL@@@d_mac", values.get("ClientId"));
                return json.readTree("{\"OnlineStatus\":false}");
            }
        };
        assertFalse(cloud.online("GID_TERMINAL@@@d_mac"));
        var broken = new MqttCloud(config, json) {
            @Override protected tools.jackson.databind.JsonNode call(String action, Map<String,String> values) { return json.readTree("{}"); }
        };
        assertThrows(IllegalStateException.class, () -> broken.online("GID_TERMINAL@@@d_mac"));
    }
    @Test void reportValidatesEnvironmentOwnerTerminalAndMembershipBeforeFanout() {
        var terminals = mock(TerminalMapper.class); var agents = mock(AgentService.class);
        var conversations = mock(ConversationService.class); var controls = mock(ConversationControlService.class);
        var board = mock(TurnActivityBoard.class); var nodes = mock(NodeRegistry.class);
        when(terminals.findByTerminalId("d_mac")).thenReturn(terminal());
        when(conversations.viewerIds("task")).thenReturn(List.of("u_owner", "u_friend"));
        var processor = new MqttReportProcessor(terminals, agents, conversations, controls, mock(AgentModelRelayService.class), board, nodes, routes("pre"), json);
        var frame = json.readTree("{\"type\":\"TURN_PROGRESS\",\"sentAt\":123,\"payload\":{\"conversationId\":\"task\",\"agentUserId\":\"agent\",\"busy\":true}}");
        assertThrows(IllegalArgumentException.class, () -> processor.accept("report/d_mac", frame));
        verifyNoInteractions(agents, nodes);
        processor.accept("report_pre/d_mac", frame);
        verify(agents).requireOwnedAgent("agent", "u_owner");
        verify(agents).assertAgentOnNode("d_mac", "agent");
        verify(conversations).requireMember("task", "agent");
        verify(nodes).broadcast(eq(List.of("u_owner", "u_friend")), any());
        reset(nodes);
        doThrow(new IllegalArgumentException("not on terminal")).when(agents).assertAgentOnNode("d_mac", "agent");
        assertThrows(IllegalArgumentException.class, () -> processor.accept("report_pre/d_mac", frame));
        verifyNoInteractions(nodes);
    }
    @Test void publishWaitsUntilDatabaseCommitAndIsNotSentOnRollback() {
        var bridge = mock(MqttBridge.class);
        when(bridge.enabled()).thenReturn(true);
        var registry = new TerminalNodeRegistry(mock(TerminalMapper.class), mock(UserMapper.class), bridge, routes("prod"), mock(MqttPresence.class));
        var frame = NodeFrame.of(FrameType.MESSAGE_NEW, Map.of("conversationId", "task"));
        TransactionSynchronizationManager.initSynchronization();
        try {
            registry.send("d_mac", frame);
            verify(bridge, never()).publish(anyString(), any());
            TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit);
            verify(bridge).publish("deliver/terminal/d_mac", frame);
        } finally { TransactionSynchronizationManager.clearSynchronization(); }
        reset(bridge); when(bridge.enabled()).thenReturn(true);
        TransactionSynchronizationManager.initSynchronization();
        try {
            registry.send("d_mac", frame);
            TransactionSynchronizationManager.getSynchronizations().forEach(s -> s.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK));
            verify(bridge, never()).publish(anyString(), any());
        } finally { TransactionSynchronizationManager.clearSynchronization(); }
    }
    @Test void unavailablePostCommitPushDoesNotTurnSavedDataIntoAFailedRequest() {
        var bridge = mock(MqttBridge.class); when(bridge.enabled()).thenReturn(true);
        doThrow(new IllegalStateException("disconnected")).when(bridge).publish(anyString(), any());
        var registry = new TerminalNodeRegistry(mock(TerminalMapper.class),
                mock(UserMapper.class), bridge, routes("prod"), mock(MqttPresence.class));
        TransactionSynchronizationManager.initSynchronization();
        try {
            registry.send("d_mac", NodeFrame.of(FrameType.MESSAGE_NEW, Map.of()));
            assertDoesNotThrow(() -> TransactionSynchronizationManager.getSynchronizations().forEach(TransactionSynchronization::afterCommit));
        } finally { TransactionSynchronizationManager.clearSynchronization(); }
    }
    @Test void onlineComesOnlyFromTheBrokerAndQueryFailuresRemainUnknown() {
        var terminals = mock(TerminalMapper.class);
        var bridge = mock(MqttBridge.class); var presence = mock(MqttPresence.class);
        when(terminals.findByTerminalId("d_mac")).thenReturn(terminal());
        var registry = new TerminalNodeRegistry(terminals, mock(UserMapper.class), bridge, routes("prod"), presence);
        assertFalse(registry.isTerminalOnline("d_mac")); verifyNoInteractions(presence);
        when(bridge.enabled()).thenReturn(true);
        when(presence.online("d_mac")).thenReturn(true);
        assertTrue(registry.isTerminalOnline("d_mac"));
        when(presence.online("d_mac")).thenThrow(new IllegalStateException("query unavailable"));
        assertThrows(PresenceUnknownException.class, () -> registry.isTerminalOnline("d_mac"));
    }
    @Test void accountFanoutIncludesFriendsAndDeduplicatesOwnersOfAgentMembers() {
        var users = mock(UserMapper.class); var bridge = mock(MqttBridge.class); when(bridge.enabled()).thenReturn(true);
        var owner = new UserEntity(); owner.setUserId("owner"); owner.setIsAgent(false);
        var friend = new UserEntity(); friend.setUserId("friend"); friend.setIsAgent(false);
        var agent = new UserEntity(); agent.setUserId("agent"); agent.setIsAgent(true); agent.setOwner("owner");
        when(users.findByUserIds(List.of("owner", "agent", "friend"))).thenReturn(List.of(friend, agent, owner));
        var registry = new TerminalNodeRegistry(mock(TerminalMapper.class), users,
                bridge, routes("pre"), mock(MqttPresence.class));
        var frame = NodeFrame.of(FrameType.TURN_PROGRESS, Map.of());
        registry.broadcast(List.of("owner", "agent", "friend", "agent"), frame);
        verify(bridge, times(1)).publish("deliver/user/owner", frame);
        verify(bridge, times(1)).publish("deliver/user/friend", frame);
        // One batched member lookup (MessageWriter holds the conversation row lock meanwhile), never one per member.
        verify(users, times(1)).findByUserIds(List.of("owner", "agent", "friend"));
        verify(users, never()).findByUserId(anyString());
    }

    @Test void emptyOrDisabledBroadcastDoesNotQueryMembers() {
        var users = mock(UserMapper.class); var bridge = mock(MqttBridge.class);
        var registry = new TerminalNodeRegistry(mock(TerminalMapper.class), users,
                bridge, routes("pre"), mock(MqttPresence.class));
        var frame = NodeFrame.of(FrameType.TURN_PROGRESS, Map.of());
        registry.broadcast(List.of("owner"), frame);
        when(bridge.enabled()).thenReturn(true);
        registry.broadcast(List.of(), frame);
        verifyNoInteractions(users);
        verify(bridge, never()).publish(anyString(), any());
    }

    @Test void agentTargetedCommandsGoOnlyToTheirExecutionTerminal() {
        var users = mock(UserMapper.class); var bridge = mock(MqttBridge.class); when(bridge.enabled()).thenReturn(true);
        when(users.findTerminalIdOfAgent("agent")).thenReturn("d_mac");
        var registry = new TerminalNodeRegistry(mock(TerminalMapper.class), users,
                bridge, routes("prod"), mock(MqttPresence.class));
        var frame = NodeFrame.of(FrameType.AGENT_UPDATED, Map.of("agentUserId", "agent"));
        registry.sendToUser("agent", frame);
        verify(bridge).publish("deliver/terminal/d_mac", frame);
        verify(bridge, never()).publish(startsWith("deliver/user/"), any());
    }

}
