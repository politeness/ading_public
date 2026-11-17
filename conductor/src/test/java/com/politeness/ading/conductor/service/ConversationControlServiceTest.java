package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.error.ConversationError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

class ConversationControlServiceTest {
    private final ConversationService conversations = mock(ConversationService.class);
    private final TerminalMapper terminals = mock(TerminalMapper.class);
    private final NodeRegistry nodes = mock(NodeRegistry.class);
    private final ConversationControlService service = new ConversationControlService(conversations, terminals, nodes);
    private final ObjectMapper json = new ObjectMapper();

    ConversationControlServiceTest() {
        for (String id : List.of("caller", "remote", "second")) {
            TerminalEntity terminal = new TerminalEntity(); terminal.setTerminalId(id); terminal.setOwner("owner");
            when(terminals.findByTerminalId(id)).thenReturn(terminal);
            when(nodes.isTerminalOnline(id)).thenReturn(true);
        }
        when(conversations.memberUsers("task")).thenReturn(List.of(agent("a", "remote"), agent("b", "remote")));
    }

    private UserEntity agent(String id, String terminalId) {
        UserEntity user = new UserEntity(); user.setUserId(id); user.setIsAgent(true);
        user.setOwner("owner"); user.setTerminalId(terminalId); return user;
    }

    @Test void sharedAgentControlAndReceiptCrossAccountsOnlyWhileGranted() {
        terminals.findByTerminalId("caller").setOwner("friend");
        service.request("friend", "caller", json.readTree("{\"requestId\":\"shared\",\"conversationId\":\"task\",\"action\":\"pause\"}"));
        verify(conversations, atLeastOnce()).requireAgentAccess(eq("friend"), any());
        verify(nodes).send(eq("remote"), argThat(f -> f.type() == FrameType.CONVERSATION_CONTROL));
        service.result("owner", "remote", json.readTree("{\"requestId\":\"shared\",\"conversationId\":\"task\",\"action\":\"pause\",\"requesterTerminalId\":\"caller\",\"ok\":true}"));
        verify(nodes).send(eq("caller"), argThat(f -> f.type() == FrameType.CONVERSATION_CONTROL_RESULT));
        clearInvocations(nodes);
        doThrow(new BizException(ConversationError.AGENT_PRIVATE)).when(conversations).requireAgentAccess(eq("friend"), any());
        service.request("friend", "caller", json.readTree("{\"requestId\":\"revoked\",\"conversationId\":\"task\",\"action\":\"pause\"}"));
        verify(nodes, never()).send(eq("remote"), any());
    }

    @Test void routesOnlyThisTasksAgentsAndUsesAuthenticatedRequester() {
        service.request("owner", "caller", json.readTree("""
                {"requestId":"r","conversationId":"task","action":"pause","requesterTerminalId":"forged"}
                """));
        ArgumentCaptor<NodeFrame> command = ArgumentCaptor.forClass(NodeFrame.class);
        verify(nodes, times(1)).send(eq("remote"), command.capture());
        assertEquals(FrameType.CONVERSATION_CONTROL, command.getValue().type());
        var payload = json.valueToTree(command.getValue().payload());
        assertEquals("caller", payload.path("requesterTerminalId").asText());
        assertEquals("task", payload.path("conversationId").asText());
        assertEquals("pause", payload.path("action").asText());
        assertTrue(payload.path("expiresAt").asLong() > System.currentTimeMillis());
        verify(nodes).send(eq("caller"), argThat(f -> f.type() == FrameType.CONVERSATION_CONTROL_ACCEPTED));
        verify(nodes, never()).send(eq("second"), any());
    }

    @Test void validatesEveryTargetBeforeDispatchAndSupportsResume() {
        when(conversations.memberUsers("task")).thenReturn(List.of(agent("a", "remote"), agent("b", "second")));
        when(nodes.isTerminalOnline("second")).thenReturn(false);
        service.request("owner", "caller", json.readTree("{\"requestId\":\"r\",\"conversationId\":\"task\",\"action\":\"resume\"}"));
        verify(nodes, never()).send(eq("remote"), any());
        verify(nodes, never()).send(eq("second"), any());
        verify(nodes).send(eq("caller"), argThat(f -> json.valueToTree(f.payload()).path("error").asText().equals("AGENT_009")));
    }

    @Test void nonMemberAndForeignAgentCannotBeControlled() {
        when(conversations.requireAccessible("task", "owner")).thenThrow(new BizException(ConversationError.NOT_A_MEMBER));
        service.request("owner", "caller", json.readTree("{\"requestId\":\"r\",\"conversationId\":\"task\",\"action\":\"pause\"}"));
        verify(nodes, never()).send(eq("remote"), any());
        reset(conversations, nodes);
        UserEntity foreign = agent("a", "remote"); foreign.setOwner("someone-else");
        when(conversations.memberUsers("task")).thenReturn(List.of(foreign));
        doThrow(new BizException(ConversationError.AGENT_PRIVATE)).when(conversations).requireAgentAccess("owner", foreign);
        service.request("owner", "caller", json.readTree("{\"requestId\":\"r\",\"conversationId\":\"task\",\"action\":\"pause\"}"));
        verify(nodes, never()).send(eq("remote"), any());
    }

    @Test void resultUsesAuthenticatedExecutorAndCannotReachAnotherAccount() {
        var result = json.readTree("""
                {"requestId":"r","conversationId":"task","action":"pause","requesterTerminalId":"caller","terminalId":"forged","ok":true}
                """);
        service.result("owner", "remote", result);
        verify(nodes).send(eq("caller"), argThat(f -> f.type() == FrameType.CONVERSATION_CONTROL_RESULT
                && json.valueToTree(f.payload()).path("terminalId").asText().equals("remote")));
        assertThrows(BizException.class, () -> service.result("owner", "second", result));
        terminals.findByTerminalId("caller").setOwner("another-account");
        when(conversations.requireAccessible("task", "another-account")).thenThrow(new BizException(ConversationError.NOT_A_MEMBER));
        assertThrows(BizException.class, () -> service.result("owner", "remote", result));
    }
}
