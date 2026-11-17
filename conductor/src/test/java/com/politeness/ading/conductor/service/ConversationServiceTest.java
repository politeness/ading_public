package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.entity.ConversationUserRelEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.entity.WorkspaceEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

class ConversationServiceTest {

    private final ConversationMapper conversationMapper = mock(ConversationMapper.class);
    private final ConversationUserRelMapper memberMapper = mock(ConversationUserRelMapper.class);
    private final UserMapper userMapper = mock(UserMapper.class);
    private final RelationService relationService = mock(RelationService.class);
    private final NodeRegistry nodeRegistry = mock(NodeRegistry.class);
    private final WorkspaceService workspaceService = mock(WorkspaceService.class);
    private final ConversationService service = new ConversationService(
            conversationMapper, memberMapper, userMapper, relationService, nodeRegistry, new IdGenerator(), workspaceService);

    @BeforeEach
    void setUp() {
        when(userMapper.findByUserId("u_me")).thenReturn(user("u_me", false, null));
        when(userMapper.findByUserId("u_codex")).thenReturn(user("u_codex", true, "u_me"));
        when(userMapper.findByUserId("u_claude")).thenReturn(user("u_claude", true, "u_me"));
        when(userMapper.findByUserId("u_others_agent")).thenReturn(user("u_others_agent", true, "u_other"));
        when(relationService.isFriend(anyString(), anyString())).thenReturn(false);
        WorkspaceEntity inbox = new WorkspaceEntity();
        inbox.setWorkspaceId("w_inbox");
        when(workspaceService.resolveForConversation(eq("u_me"), any())).thenReturn(inbox);
    }

    @Test
    void ownerCanReadOnEveryTerminalWithoutGainingHumanMembership() {
        ConversationEntity conversation = new ConversationEntity(); conversation.setConversationId("shared");
        when(conversationMapper.findByConversationId("shared")).thenReturn(conversation);
        UserEntity agent = user("agent", true, "u_me"); agent.setTerminalId("executor");
        when(memberMapper.listMemberIds("shared")).thenReturn(List.of("agent"));
        when(userMapper.findByUserIds(List.of("agent"))).thenReturn(List.of(agent));
        try {
            com.politeness.ading.conductor.common.auth.AuthContext.set(com.politeness.ading.conductor.common.auth.Principal.ofUser("u_me"));
            assertSame(conversation, service.requireAccessible("shared", "u_me"));
            com.politeness.ading.conductor.common.auth.AuthContext.set(com.politeness.ading.conductor.common.auth.Principal.ofNode("u_me", "wrong"));
            assertSame(conversation, service.requireAccessible("shared", "u_me"));
            com.politeness.ading.conductor.common.auth.AuthContext.set(com.politeness.ading.conductor.common.auth.Principal.ofNode("u_me", "executor"));
            assertSame(conversation, service.requireAccessible("shared", "u_me"));
            assertThrows(BizException.class, () -> service.requireMember("shared", "u_me"));
            service.setOwnerPaused("shared", "u_me", true);
            verify(memberMapper).setOwnerPaused("shared", "u_me", true);
            assertThrows(BizException.class, () -> service.setOwnerPaused("shared", "stranger", true));
            assertThrows(BizException.class, () -> service.requireAccessible("shared", "stranger"));
            com.politeness.ading.conductor.common.auth.AuthContext.set(com.politeness.ading.conductor.common.auth.Principal.ofUser("u_me"));
            assertThrows(BizException.class, () -> service.updateMutable("shared", "u_me",
                    new ConversationService.UpdateCommand("changed", null, null, null, null, null, null, false)));
            assertThrows(BizException.class, () -> service.updateMember("shared", "u_me", "agent", null, true, null));
        } finally { com.politeness.ading.conductor.common.auth.AuthContext.clear(); }
    }

    @Test
    void groupIncludesSharedAgentOwnerButDirectDoesNot() {
        when(userMapper.findByUserId("u_other")).thenReturn(user("u_other", false, null));
        when(relationService.canUseAgent(eq("u_me"), any())).thenReturn(true);
        ConversationEntity group = service.create("u_me", new ConversationService.CreateCommand(
                null, "GROUP", "group", List.of("u_others_agent"), null, null, false, null, null));
        ArgumentCaptor<ConversationUserRelEntity> added = ArgumentCaptor.forClass(ConversationUserRelEntity.class);
        verify(memberMapper, times(3)).upsert(added.capture());
        assertEquals(List.of("u_me", "u_others_agent", "u_other"), added.getAllValues().stream().map(ConversationUserRelEntity::getUserId).toList());
        assertEquals("GROUP", group.getType());
        service.create("u_me", command(null, List.of("u_others_agent"), null));
        verify(memberMapper, times(5)).upsert(any());
    }

    @Test
    void agentOwnerCannotBeRemovedWhileAgentRemains() {
        ConversationEntity group = new ConversationEntity(); group.setConversationId("group"); group.setType("GROUP"); group.setOwner("u_me");
        when(conversationMapper.findByConversationId("group")).thenReturn(group);
        when(memberMapper.findMember(eq("group"), anyString())).thenReturn(new ConversationUserRelEntity());
        when(memberMapper.listMemberIds("group")).thenReturn(List.of("u_me", "u_other", "u_others_agent"));
        when(userMapper.findByUserIds(any())).thenReturn(List.of(user("u_others_agent", true, "u_other")));
        assertThrows(BizException.class, () -> service.removeMember("group", "u_me", "u_other"));
        verify(memberMapper, never()).removeMember("group", "u_other");
    }

    @Test
    void sharedAgentCanJoinOnlyWhenEveryHumanHasAccess() {
        UserEntity friend = user("friend", false, null);
        when(userMapper.findByUserId("friend")).thenReturn(friend);
        when(relationService.isFriend("u_me", "friend")).thenReturn(true);
        when(relationService.canUseAgent(eq("friend"), any())).thenReturn(true);
        service.create("u_me", command(null, List.of("u_codex", "friend"), null));
        when(relationService.canUseAgent(eq("friend"), any())).thenReturn(false);
        assertThrows(BizException.class, () -> service.create("u_me", command(null, List.of("u_codex", "friend"), null)));
        ConversationEntity conversation = new ConversationEntity(); conversation.setConversationId("shared"); conversation.setType("GROUP");
        when(memberMapper.listMemberIds("shared")).thenReturn(List.of("u_codex", "friend"));
        when(userMapper.findByUserIds(List.of("u_codex", "friend"))).thenReturn(List.of(user("u_codex", true, "u_me"), friend));
        assertThrows(BizException.class, () -> service.requireCanSpeak(conversation, "friend"));
    }

    @Test
    void ownAgentCanBeAddedWithoutBeingFriend() {
        ConversationEntity conversation = service.create("u_me", command(null, List.of("u_codex"), null));

        assertEquals(ConversationEntity.TYPE_DIRECT, conversation.getType());
        assertEquals("w_inbox", conversation.getWorkspaceId(), "Without a workspace it goes into \"No workspace\"");
        verify(memberMapper, times(2)).upsert(any());
    }

    @Test
    void othersAgentCannotBeAddedWithoutFriendship() {
        BizException error = assertThrows(BizException.class,
                () -> service.create("u_me", command(null, List.of("u_others_agent"), null)));
        assertEquals("CONVERSATION_010", error.getError().code());
        verify(conversationMapper, never()).insert(any());
    }

    @Test
    void clientComputedRolesSavedAsIs() {
        service.create("u_me", command(null, null, List.of(
                new ConversationService.MemberSpec("u_codex", "engineer"),
                new ConversationService.MemberSpec("u_claude", "LEADER"))));

        ArgumentCaptor<ConversationUserRelEntity> rows = ArgumentCaptor.forClass(ConversationUserRelEntity.class);
        verify(memberMapper, times(3)).upsert(rows.capture());
        Map<String, String> roles = rows.getAllValues().stream()
                .collect(Collectors.toMap(ConversationUserRelEntity::getUserId, ConversationUserRelEntity::getRole));
        assertEquals(Map.of("u_me", "ENGINEER", "u_codex", "ENGINEER", "u_claude", "LEADER"), roles,
                "Who is Leader is decided by the desktop's shared scheduling rules; the backend does not change it");
    }

    @Test
    void replayingSameConversationIdReturnsOriginalWithoutDuplicate() {
        ConversationEntity existing = new ConversationEntity();
        existing.setConversationId("conversation_client");
        existing.setCreator("u_me");
        when(conversationMapper.findByConversationId("conversation_client")).thenReturn(existing);

        assertSame(existing, service.create("u_me", command("conversation_client", List.of("u_codex"), null)));
        verify(conversationMapper, never()).insert(any());
    }

    @Test
    void conversationIdTakenBySomeoneElseCannotBeUsed() {
        ConversationEntity existing = new ConversationEntity();
        existing.setConversationId("conversation_taken");
        existing.setCreator("u_other");
        when(conversationMapper.findByConversationId("conversation_taken")).thenReturn(existing);

        BizException error = assertThrows(BizException.class,
                () -> service.create("u_me", command("conversation_taken", List.of("u_codex"), null)));
        assertEquals("CONVERSATION_011", error.getError().code());
    }

    @Test
    void deletedConversationTreatedAsMissing_deletingAgainDoesNotError() {
        ConversationEntity deleted = new ConversationEntity();
        deleted.setConversationId("conversation_gone");
        deleted.setIsDeleted(true);
        when(conversationMapper.findByConversationId("conversation_gone")).thenReturn(deleted);

        BizException error = assertThrows(BizException.class, () -> service.require("conversation_gone"));
        assertEquals("CONVERSATION_001", error.getError().code());
        service.delete("conversation_gone", "u_me");
        verify(conversationMapper, never()).softDelete(anyString());
    }

    @Test
    void nonActivityChangesLikePauseDoNotChangeConversationOrder() {
        ConversationEntity conversation = new ConversationEntity();
        conversation.setConversationId("conversation_1");
        conversation.setIsDeleted(false);
        when(conversationMapper.findByConversationId("conversation_1")).thenReturn(conversation);
        when(memberMapper.findMember("conversation_1", "u_me")).thenReturn(new ConversationUserRelEntity());

        service.updateMutable("conversation_1", "u_me",
                new ConversationService.UpdateCommand(null, null, null, null, true, null, null, false));

        verify(conversationMapper).updateMutable(any());
        verify(conversationMapper, never()).touch(anyString());
    }

    private static ConversationService.CreateCommand command(String conversationId, List<String> memberIds,
                                                     List<ConversationService.MemberSpec> members) {
        return new ConversationService.CreateCommand(conversationId, null, "整理报销单", memberIds, members, null, null, null, null);
    }

    private static UserEntity user(String userId, boolean agent, String owner) {
        UserEntity user = new UserEntity();
        user.setUserId(userId);
        user.setIsAgent(agent);
        user.setOwner(owner);
        return user;
    }
}
