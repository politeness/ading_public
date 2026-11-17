package com.politeness.ading.conductor.service;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.entity.*;
import com.politeness.ading.conductor.dal.mapper.*;
import com.politeness.ading.conductor.manager.NodeRegistry;
import com.politeness.ading.conductor.manager.FrameType;
import java.util.*;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
class AgentSharingTest {
    final UserRelMapper rel = mock(UserRelMapper.class);
    final UserMapper users = mock(UserMapper.class);
    final NodeRegistry nodes = mock(NodeRegistry.class);
    final RelationService service = new RelationService(rel, users, nodes);
    UserEntity user(String id, boolean agent, String owner) {
        UserEntity u = new UserEntity(); u.setUserId(id); u.setIsAgent(agent); u.setOwner(owner); return u;
    }
    @Test void ownerGrantsOnlyToHumanFriendsAndRecipientCannotReshare() {
        UserEntity agent = user("agent", true, "owner");
        when(users.findByUserId("agent")).thenReturn(agent);
        when(users.findByUserId("friend")).thenReturn(user("friend", false, null));
        when(rel.countAccepted("owner", "friend")).thenReturn(1);
        service.shareAgent("owner", "agent", "friend", true);
        var grant = ArgumentCaptor.forClass(UserRelEntity.class);
        verify(rel).upsert(grant.capture());
        assertEquals("SHARED", grant.getValue().getStatus());
        assertEquals("friend", grant.getValue().getUserId());
        assertThrows(BizException.class, () -> service.shareAgent("friend", "agent", "owner", true));
        when(rel.countAccepted("owner", "friend")).thenReturn(0);
        assertThrows(BizException.class, () -> service.shareAgent("owner", "agent", "friend", true));
        service.shareAgent("owner", "agent", "friend", false);
        verify(rel).revokeAgent("friend", "agent");
    }
    @Test void accessRequiresBothExplicitGrantAndCurrentFriendship() {
        UserEntity agent = user("agent", true, "owner");
        assertTrue(service.canUseAgent("owner", agent));
        when(rel.countAccepted("friend", "owner")).thenReturn(1);
        assertFalse(service.canUseAgent("friend", agent));
        UserRelEntity grant = new UserRelEntity(); grant.setStatus("SHARED");
        when(rel.find("friend", "agent")).thenReturn(grant);
        assertTrue(service.canUseAgent("friend", agent));
        when(rel.countAccepted("friend", "owner")).thenReturn(0);
        assertFalse(service.canUseAgent("friend", agent));
        when(rel.find("friend", "agent")).thenReturn(null);
        assertFalse(service.canUseAgent("friend", agent));
    }
    @Test void everyGranteeRefreshesAfterSubsequentGrantAndRevocation() {
        when(users.findByUserId("agent")).thenReturn(user("agent", true, "owner"));
        for (String id : List.of("alice", "bob", "carol")) {
            when(users.findByUserId(id)).thenReturn(user(id, false, null));
            when(rel.countAccepted("owner", id)).thenReturn(1);
        }
        Set<String> recipients = new LinkedHashSet<>();
        when(rel.upsert(any())).thenAnswer(call -> {
            recipients.add(call.getArgument(0, UserRelEntity.class).getUserId());
            return 1;
        });
        when(rel.revokeAgent(anyString(), eq("agent"))).thenAnswer(call -> {
            recipients.remove(call.getArgument(0, String.class));
            return 1;
        });
        when(rel.listAgentRecipients("agent")).thenAnswer(call -> new ArrayList<>(recipients));

        service.shareAgent("owner", "agent", "alice", true);
        service.shareAgent("owner", "agent", "bob", true);
        service.shareAgent("owner", "agent", "alice", false);
        service.shareAgent("owner", "agent", "carol", true);

        var audiences = ArgumentCaptor.forClass(Collection.class);
        verify(nodes, times(4)).broadcast(audiences.capture(), argThat(frame -> frame.type() == FrameType.FRIENDS_CHANGED));
        var sent = audiences.getAllValues();
        assertEquals(Set.of("owner", "alice"), new HashSet<>(sent.get(0)));
        assertEquals(Set.of("owner", "alice", "bob"), new HashSet<>(sent.get(1)), "Alice must learn that Bob now has access too");
        assertEquals(Set.of("owner", "alice", "bob"), new HashSet<>(sent.get(2)), "Both the revoked person and remaining recipients refresh");
        assertEquals(Set.of("owner", "bob", "carol"), new HashSet<>(sent.get(3)), "Revoked recipients are not notified about later grants");
    }

    @Test void rejectedShareDoesNotNotifyRecipients() {
        when(users.findByUserId("agent")).thenReturn(user("agent", true, "owner"));
        when(users.findByUserId("stranger")).thenReturn(user("stranger", false, null));
        assertThrows(BizException.class, () -> service.shareAgent("owner", "agent", "stranger", true));
        verifyNoInteractions(nodes);
        verify(rel, never()).upsert(any());
    }

}
