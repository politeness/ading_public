package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.AgentController;
import com.politeness.ading.conductor.controller.MqttController;
import com.politeness.ading.conductor.controller.NodeController;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.controller.dto.AgentRegisterRequest;
import com.politeness.ading.conductor.controller.dto.AgentSessionUpsertRequest;
import com.politeness.ading.conductor.controller.dto.AgentStateReport;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.dal.mapper.WorkspaceMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import com.politeness.ading.conductor.manager.TurnActivityBoard;
import com.politeness.ading.conductor.mqtt.MqttCredentialsService;
import com.politeness.ading.conductor.mqtt.MqttReportProcessor;
import com.politeness.ading.conductor.mqtt.MqttRoutes;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.ObjectMapper;

/** The phone is an auxiliary terminal: it can register, rotate MQTT credentials and issue task control, but cannot perform any execution-side action. */
class ExecutionTerminalTest {
    private static final String NOT_EXECUTION = "NODE_007";
    private final TerminalMapper terminals = mock(TerminalMapper.class);
    private final NodeService nodes = new NodeService(terminals, new IdGenerator());
    private final AgentService agents = mock(AgentService.class);
    private final AgentStateService states = mock(AgentStateService.class);

    ExecutionTerminalTest() {
        when(terminals.findByTerminalId("t_mac")).thenReturn(terminal("t_mac", TerminalEntity.TYPE_DESKTOP));
        when(terminals.findByTerminalId("t_phone")).thenReturn(terminal("t_phone", TerminalEntity.TYPE_MOBILE));
    }

    @AfterEach void clearPrincipal() { AuthContext.clear(); }

    static TerminalEntity terminal(String id, String type) {
        var terminal = new TerminalEntity();
        terminal.setTerminalId(id); terminal.setType(type); terminal.setOwner("u_me"); terminal.setStatus(TerminalEntity.STATUS_OFFLINE);
        return terminal;
    }

    private static void assertNotExecution(Runnable action) {
        assertEquals(NOT_EXECUTION, assertThrows(BizException.class, action::run).getError().code());
    }

    @Test void phoneTokenCannotRegisterAgentsWriteThreadsOrPublishAgentStates() {
        AuthContext.set(Principal.ofNode("u_me", "t_phone"));
        var agentApi = new AgentController(agents, states, mock(ConversationService.class), new TurnActivityBoard(), nodes);
        var nodeApi = new NodeController(nodes, mock(TokenService.class), mock(UserMapper.class), states, mock(NodeRegistry.class), mock(com.politeness.ading.conductor.service.DeviceService.class));
        assertNotExecution(() -> agentApi.register(new AgentRegisterRequest("codex@phone", "CODEX", "1", null)));
        assertNotExecution(() -> agentApi.upsertSession("u_agent", "c_1", new AgentSessionUpsertRequest("thread", "/tmp")));
        assertNotExecution(() -> nodeApi.publishAgentStates(new AgentStateReport(List.of())));
        verifyNoInteractions(agents, states);
    }

    @Test void computerTokenStillRegistersAgentsAndPublishesStates() {
        AuthContext.set(Principal.ofNode("u_me", "t_mac"));
        var agent = new com.politeness.ading.conductor.dal.entity.UserEntity(); agent.setUserId("u_codex"); agent.setIsAgent(true);
        when(agents.register("t_mac", "u_me", "codex@mac", "CODEX", "1", null)).thenReturn(agent);
        var agentApi = new AgentController(agents, states, mock(ConversationService.class), new TurnActivityBoard(), nodes);
        var nodeApi = new NodeController(nodes, mock(TokenService.class), mock(UserMapper.class), states, mock(NodeRegistry.class), mock(com.politeness.ading.conductor.service.DeviceService.class));
        agentApi.register(new AgentRegisterRequest("codex@mac", "CODEX", "1", null));
        nodeApi.publishAgentStates(new AgentStateReport(List.of()));
        verify(agents).register("t_mac", "u_me", "codex@mac", "CODEX", "1", null);
        verify(states).publish("t_mac", "u_me", List.of());
    }

    @Test void phoneKeepsItsAuxiliaryAbilities() {
        // Terminal registration (idempotent re-registration) and MQTT credential rotation are not restricted to execution terminals
        when(terminals.findByOwnerAndFingerprint("u_me", "phone-uuid")).thenReturn(terminal("t_phone", TerminalEntity.TYPE_MOBILE));
        assertEquals("t_phone", nodes.register("u_me", "phone-uuid", "iPhone", TerminalEntity.TYPE_MOBILE).getTerminalId());
        AuthContext.set(Principal.ofNode("u_me", "t_phone"));
        var credentials = mock(MqttCredentialsService.class);
        new MqttController(nodes, credentials).credentials();
        verify(credentials).issue(argThat(terminal -> "t_phone".equals(terminal.getTerminalId())));
    }

    @Test void workspaceCanOnlyBeBoundToAComputer() {
        var workspaces = mock(WorkspaceMapper.class);
        var service = new WorkspaceService(workspaces, mock(ConversationMapper.class), mock(UserMapper.class), nodes, new IdGenerator());
        assertNotExecution(() -> service.create("u_me", null, "t_phone", "项目", "/Users/me/project"));
        verify(workspaces, never()).insert(any());
        service.create("u_me", null, "t_mac", "项目", "/Users/me/project");
        verify(workspaces).insert(argThat(workspace -> "t_mac".equals(workspace.getTerminalId())));
    }

    @Test void phoneReportsCanRequestControlButNotReportProgressOrControlResults() {
        var json = new ObjectMapper();
        var conversations = mock(ConversationService.class);
        var controls = mock(ConversationControlService.class);
        var registry = mock(NodeRegistry.class);
        var processor = new MqttReportProcessor(terminals, agents, conversations, controls, mock(AgentModelRelayService.class), new TurnActivityBoard(),
                registry, new MqttRoutes(new AdingProperties(), new MockEnvironment()), json);
        var progress = json.readTree("{\"type\":\"TURN_PROGRESS\",\"payload\":{\"conversationId\":\"c_1\",\"agentUserId\":\"u_agent\",\"busy\":true}}");
        var result = json.readTree("{\"type\":\"CONVERSATION_CONTROL_RESULT\",\"payload\":{\"requestId\":\"r\",\"conversationId\":\"c_1\",\"action\":\"pause\",\"requesterTerminalId\":\"t_mac\",\"ok\":true}}");
        var request = json.readTree("{\"type\":\"CONVERSATION_CONTROL\",\"payload\":{\"requestId\":\"r\",\"conversationId\":\"c_1\",\"action\":\"pause\"}}");
        assertNotExecution(() -> processor.accept("report_dev/t_phone", progress));
        assertNotExecution(() -> processor.accept("report_dev/t_phone", result));
        verifyNoInteractions(agents, conversations, registry);
        verify(controls, never()).result(anyString(), anyString(), any());
        processor.accept("report_dev/t_phone", request);
        verify(controls).request(eq("u_me"), eq("t_phone"), any());
        processor.accept("report_dev/t_mac", result);
        verify(controls).result(eq("u_me"), eq("t_mac"), any());
    }

    @Test void agentModelReportsReachTheRelayOnlyFromComputers() {
        var json = new ObjectMapper();
        var relay = mock(AgentModelRelayService.class);
        var processor = new MqttReportProcessor(terminals, agents, mock(ConversationService.class), mock(ConversationControlService.class), relay, new TurnActivityBoard(),
                mock(NodeRegistry.class), new MqttRoutes(new AdingProperties(), new MockEnvironment()), json);
        var request = json.readTree("{\"type\":\"AGENT_MODEL_REQUEST\",\"payload\":{\"requestId\":\"r\",\"agentUserId\":\"u_agent\",\"action\":\"catalog\"}}");
        var result = json.readTree("{\"type\":\"AGENT_MODEL_RESULT\",\"payload\":{\"requestId\":\"r\",\"agentUserId\":\"u_agent\",\"requesterTerminalId\":\"t_mac\",\"ok\":true}}");
        assertNotExecution(() -> processor.accept("report_dev/t_phone", request));
        assertNotExecution(() -> processor.accept("report_dev/t_phone", result));
        verifyNoInteractions(relay);
        processor.accept("report_dev/t_mac", request);
        verify(relay).request(eq("u_me"), eq("t_mac"), any());
        processor.accept("report_dev/t_mac", result);
        verify(relay).result(eq("u_me"), eq("t_mac"), any());
    }

    @Test void registrationRequiresAnExplicitTerminalType() {
        when(terminals.findByOwnerAndFingerprint("u_me", "mac-fp")).thenReturn(null);
        assertThrows(BizException.class, () -> nodes.register("u_me", "mac-fp", null, null));
    }
}
