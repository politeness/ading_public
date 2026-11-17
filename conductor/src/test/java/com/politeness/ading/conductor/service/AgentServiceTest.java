package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.AgentSessionMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.FrameType;
import org.junit.jupiter.api.Test;

class AgentServiceTest {

    private final AgentService service = new AgentService(
            mock(UserMapper.class), mock(AgentSessionMapper.class),
            mock(RelationService.class), mock(NodeRegistry.class), new IdGenerator());

    @Test
    void allDesktopSupportedAgentsCanRegisterToCloud() {
        for (String type : new String[] {"codex", "claude_code", "qoder", "qoder_cn", "qwen_code", "kiro", "copilot", "antigravity"}) {
            UserEntity agent = service.register("d_mac", "u_me", "uuid-" + type, type, "1.0", null);
            assertEquals(type.toUpperCase(), agent.getAgentType());
        }
    }

    @Test
    void qoderCnHasItsOwnDefaultDisplayName() {
        UserEntity agent = service.register("d_mac", "u_me", "uuid-cn", "QODER_CN", "1.0", null);
        assertEquals("Qoder CN", agent.getDisplayName());
    }

    @Test
    void qwenCodeHasItsOwnDefaultName() {
        UserEntity agent = service.register("d_mac", "u_me", "uuid-qwen", "QWEN_CODE", "0.26.1", null);
        assertEquals("Qwen Code", agent.getDisplayName());
    }

    @Test
    void registeringAgentNoLongerAddsItAsContact() {
        RelationService relations = mock(RelationService.class);
        AgentService agents = new AgentService(
                mock(UserMapper.class), mock(AgentSessionMapper.class),
                relations, mock(NodeRegistry.class), new IdGenerator());
        agents.register("d_mac", "u_me", "uuid-x", "CODEX", "1.0", null);
        verify(relations, never()).befriend(anyString(), anyString());
    }

    @Test
    void ownerAndSharedUsersCanRequestCheckAndRevocationTakesEffectImmediately() {
        UserMapper users = mock(UserMapper.class);
        NodeRegistry nodes = mock(NodeRegistry.class);
        RelationService relations = mock(RelationService.class);
        AgentService agents = new AgentService(users, mock(AgentSessionMapper.class),
                relations, nodes, new IdGenerator());
        UserEntity agent = new UserEntity();
        agent.setUserId("u_agent");
        agent.setOwner("u_owner");
        agent.setIsAgent(true);
        agent.setTerminalId("d_home");
        when(users.findByUserId("u_agent")).thenReturn(agent);
        when(nodes.isOnline("u_agent")).thenReturn(true);

        when(relations.canUseAgent("u_shared", agent)).thenReturn(true);
        agents.requestStatusRefresh("u_agent", "u_shared");
        verify(nodes).sendToUser(org.mockito.ArgumentMatchers.eq("u_agent"),
                org.mockito.ArgumentMatchers.argThat(frame -> frame.type() == FrameType.AGENT_VERIFY_REQUEST));
        org.mockito.Mockito.clearInvocations(nodes);
        agents.requestStatusRefresh("u_agent", "u_owner");
        org.mockito.ArgumentCaptor<NodeFrame> frame = org.mockito.ArgumentCaptor.forClass(NodeFrame.class);
        verify(nodes).sendToUser(org.mockito.ArgumentMatchers.eq("u_agent"), frame.capture());
        assertEquals(FrameType.AGENT_VERIFY_REQUEST, frame.getValue().type());

        org.mockito.Mockito.clearInvocations(nodes);
        assertThrows(BizException.class, () -> agents.requestStatusRefresh("u_agent", "u_other"));
        when(relations.canUseAgent("u_shared", agent)).thenReturn(false);
        assertThrows(BizException.class, () -> agents.requestStatusRefresh("u_agent", "u_shared"));
        assertThrows(BizException.class, () -> agents.update("u_agent", "u_shared", "name", null, null));
        assertThrows(BizException.class, () -> agents.requestStatusRefresh("missing", "u_owner"));
        org.mockito.Mockito.verifyNoInteractions(nodes);
        when(nodes.isOnline("u_agent")).thenReturn(false);
        assertThrows(BizException.class, () -> agents.requestStatusRefresh("u_agent", "u_owner"));
    }

    @Test
    void concurrentRegistrationConflictReturnsCommittedIdentityForSameIdempotencyKey() {
        UserMapper users = mock(UserMapper.class);
        AgentService agents = new AgentService(users, mock(AgentSessionMapper.class),
                mock(RelationService.class), mock(NodeRegistry.class), new IdGenerator());
        UserEntity winner = new UserEntity();
        winner.setUserId("u_winner"); winner.setOwner("u_owner"); winner.setAgentType("ANTIGRAVITY");
        org.mockito.Mockito.doThrow(new org.springframework.dao.DuplicateKeyException("uk_terminal_local"))
                .when(users).insert(org.mockito.ArgumentMatchers.any(UserEntity.class));
        when(users.findRegisteredAgentForUpdate("d_mac", "antigravity@mac")).thenReturn(winner);
        assertEquals("u_winner", agents.register("d_mac", "u_owner", "antigravity@mac", "ANTIGRAVITY", "1", null).getUserId());
        verify(users).findRegisteredAgentForUpdate("d_mac", "antigravity@mac");
        assertThrows(org.springframework.dao.DuplicateKeyException.class,
                () -> agents.register("d_other", "u_owner", "antigravity@mac", "ANTIGRAVITY", "1", null));
        winner.setOwner("u_other");
        assertThrows(org.springframework.dao.DuplicateKeyException.class,
                () -> agents.register("d_mac", "u_owner", "antigravity@mac", "ANTIGRAVITY", "1", null));
    }

    @Test
    void concurrentRegistrationKeyCollisionWritesNewerVersionBackToWinner() {
        UserMapper users = mock(UserMapper.class);
        AgentService agents = new AgentService(users, mock(AgentSessionMapper.class),
                mock(RelationService.class), mock(NodeRegistry.class), new IdGenerator());
        UserEntity winner = new UserEntity();
        winner.setUserId("u_winner"); winner.setOwner("u_owner"); winner.setAgentType("CODEX"); winner.setAgentVersion("1.0");
        org.mockito.Mockito.doThrow(new org.springframework.dao.DuplicateKeyException("uk_terminal_local"))
                .when(users).insert(org.mockito.ArgumentMatchers.any(UserEntity.class));
        when(users.findRegisteredAgentForUpdate("d_mac", "codex@mac")).thenReturn(winner);

        assertEquals("2.0", agents.register("d_mac", "u_owner", "codex@mac", "CODEX", "2.0", null).getAgentVersion());
        verify(users).updateAgentProfile(org.mockito.ArgumentMatchers.argThat(patch ->
                "u_winner".equals(patch.getUserId()) && "2.0".equals(patch.getAgentVersion())));

        org.mockito.Mockito.clearInvocations(users);
        agents.register("d_mac", "u_owner", "codex@mac", "CODEX", "2.0", null);
        verify(users, org.mockito.Mockito.never()).updateAgentProfile(org.mockito.ArgumentMatchers.any());
    }
}
