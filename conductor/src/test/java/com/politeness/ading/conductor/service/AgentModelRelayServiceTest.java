package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.controller.dto.AgentModelState;
import com.politeness.ading.conductor.controller.dto.AgentStateReport;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.AgentError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

class AgentModelRelayServiceTest {
    private final AgentService agents = mock(AgentService.class);
    private final TerminalMapper terminals = mock(TerminalMapper.class);
    private final NodeRegistry nodes = mock(NodeRegistry.class);
    private final AgentModelRelayService service = new AgentModelRelayService(agents, terminals, nodes);
    private final ObjectMapper json = new ObjectMapper();

    AgentModelRelayServiceTest() {
        UserEntity agent = new UserEntity(); agent.setUserId("a"); agent.setIsAgent(true); agent.setOwner("owner"); agent.setTerminalId("remote");
        when(agents.requireOwnedAgent("a", "owner")).thenReturn(agent);
        when(agents.requireOwnedAgent("a", "friend")).thenThrow(new BizException(AgentError.NOT_AGENT_OWNER));
        when(nodes.isTerminalOnline("remote")).thenReturn(true);
        TerminalEntity caller = new TerminalEntity(); caller.setTerminalId("caller"); caller.setOwner("owner");
        when(terminals.findByTerminalId("caller")).thenReturn(caller);
    }

    private tools.jackson.databind.JsonNode sent(String terminal) {
        ArgumentCaptor<NodeFrame> frame = ArgumentCaptor.forClass(NodeFrame.class);
        verify(nodes).send(eq(terminal), frame.capture());
        return json.valueToTree(frame.getValue().payload());
    }

    @Test void forwardsToTheAgentsComputerWithAuthenticatedRequester() {
        service.request("owner", "caller", json.readTree("""
                {"requestId":"r","agentUserId":"a","action":"set","modelId":"m","requesterTerminalId":"forged"}
                """));
        verify(nodes).send(eq("remote"), argThat(f -> f.type() == FrameType.AGENT_MODEL_REQUEST));
        var payload = sent("remote");
        assertEquals("caller", payload.path("requesterTerminalId").asText());
        assertEquals("m", payload.path("modelId").asText());
        assertEquals("set", payload.path("action").asText());
        assertTrue(payload.path("expiresAt").asLong() > System.currentTimeMillis());
        verify(nodes, never()).send(eq("caller"), any());
    }

    @Test void followingTheVendorAppHasNoModelId() {
        service.request("owner", "caller", json.readTree("{\"requestId\":\"r\",\"agentUserId\":\"a\",\"action\":\"set\",\"modelId\":null}"));
        assertTrue(sent("remote").path("modelId").isMissingNode());
    }

    @Test void offlineComputerAnswersTheRequesterWithoutForwarding() {
        when(nodes.isTerminalOnline("remote")).thenReturn(false);
        service.request("owner", "caller", json.readTree("{\"requestId\":\"r\",\"agentUserId\":\"a\",\"action\":\"catalog\"}"));
        verify(nodes, never()).send(eq("remote"), any());
        assertEquals("AGENT_009", sent("caller").path("error").asText());
    }

    @Test void borrowedAgentIsRefused() {
        service.request("friend", "caller", json.readTree("{\"requestId\":\"r\",\"agentUserId\":\"a\",\"action\":\"set\",\"modelId\":\"m\"}"));
        verify(nodes, never()).send(eq("remote"), any());
        assertEquals(AgentError.NOT_AGENT_OWNER.code(), sent("caller").path("error").asText());
    }

    @Test void resultGoesBackToTheRequesterOnlyFromTheAgentsComputer() {
        var reply = json.readTree("""
                {"requestId":"r","agentUserId":"a","requesterTerminalId":"caller","ok":true,"catalog":{"supported":true,"models":[{"id":"m","label":"M"}]}}
                """);
        assertThrows(BizException.class, () -> service.result("owner", "elsewhere", reply));
        verify(nodes, never()).send(any(), any());
        service.result("owner", "remote", reply);
        var payload = sent("caller");
        assertTrue(payload.path("ok").asBoolean());
        assertEquals("m", payload.path("catalog").path("models").get(0).path("id").asText());
        assertTrue(payload.path("requesterTerminalId").isMissingNode());
    }

    @Test void resultNeverCrossesAccounts() {
        TerminalEntity foreign = new TerminalEntity(); foreign.setTerminalId("foreign"); foreign.setOwner("friend");
        when(terminals.findByTerminalId("foreign")).thenReturn(foreign);
        assertThrows(BizException.class, () -> service.result("owner", "remote", json.readTree(
                "{\"requestId\":\"r\",\"agentUserId\":\"a\",\"requesterTerminalId\":\"foreign\",\"ok\":true}")));
        verify(nodes, never()).send(any(), any());
    }

    @Test void modelStateIsStoredNotifiesOnChangeAndOnlyTheOwnerSeesIt() {
        UserMapper users = mock(UserMapper.class);
        UserEntity agent = new UserEntity(); agent.setUserId("a"); agent.setIsAgent(true); agent.setOwner("owner"); agent.setTerminalId("remote"); agent.setReadiness("ready");
        when(users.findByUserId("a")).thenReturn(agent);
        when(terminals.findByTerminalId("remote")).thenReturn(new TerminalEntity());
        AgentStateService states = new AgentStateService(users, terminals, nodes);
        var model = new AgentModelState("m", "Model M", "n");
        assertEquals(1, states.publish("remote", "owner", List.of(new AgentStateReport.Item("a", "ready", null, model))));
        ArgumentCaptor<String> stored = ArgumentCaptor.forClass(String.class);
        verify(users).updateAgentState(eq("remote"), eq("a"), eq("ready"), isNull(), stored.capture());
        verify(nodes).sendToUser(eq("owner"), argThat(f -> f.type() == FrameType.AGENTS_CHANGED));

        // The same value is not notified again; old clients omit this field, which does not clear the existing value
        agent.setModelState(stored.getValue());
        assertEquals(0, states.publish("remote", "owner", List.of(new AgentStateReport.Item("a", "ready", null, model))));
        assertEquals(0, states.publish("remote", "owner", List.of(new AgentStateReport.Item("a", "ready", null, null))));
        verifyNoMoreInteractions(ignoreStubs(users));

        assertEquals(model, states.describeOwned(agent).model());
        assertNull(states.describe(agent).model(), "Borrowers go through describe and cannot see the model");
        agent.setModelState("not json");
        assertNull(states.describeOwned(agent).model());
    }
}
