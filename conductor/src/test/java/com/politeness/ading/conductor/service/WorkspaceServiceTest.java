package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.WorkspaceEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.dal.mapper.WorkspaceMapper;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

class WorkspaceServiceTest {

    private final WorkspaceMapper workspaceMapper = mock(WorkspaceMapper.class);
    private final ConversationMapper conversationMapper = mock(ConversationMapper.class);
    private final UserMapper userMapper = mock(UserMapper.class);
    private final NodeService nodeService = mock(NodeService.class);
    private final WorkspaceService service = new WorkspaceService(
            workspaceMapper, conversationMapper, userMapper, nodeService, new IdGenerator());

    @Test
    void firstWorkspaceListingCreatesNoWorkspace() {
        service.list("u_me");

        ArgumentCaptor<WorkspaceEntity> inserted = ArgumentCaptor.forClass(WorkspaceEntity.class);
        verify(userMapper).lockByUserId("u_me");
        verify(workspaceMapper).insert(inserted.capture());
        assertEquals(WorkspaceEntity.KIND_INBOX, inserted.getValue().getKind());
        assertEquals("无工作区", inserted.getValue().getName());
    }

    @Test
    void noWorkspaceCannotBeDeleted() {
        when(workspaceMapper.findByWorkspaceId("w_inbox")).thenReturn(workspace("w_inbox", "u_me", WorkspaceEntity.KIND_INBOX));

        BizException error = assertThrows(BizException.class, () -> service.delete("u_me", "w_inbox"));
        assertEquals("WORKSPACE_003", error.getError().code());
        verify(workspaceMapper, never()).delete(anyString());
    }

    @Test
    void deletingWorkspaceMovesConversationsToNoWorkspace_notDeleted() {
        when(workspaceMapper.findByWorkspaceId("w_project")).thenReturn(workspace("w_project", "u_me", WorkspaceEntity.KIND_FOLDER));
        when(workspaceMapper.findInbox("u_me")).thenReturn(workspace("w_inbox", "u_me", WorkspaceEntity.KIND_INBOX));

        service.delete("u_me", "w_project");

        verify(conversationMapper).moveWorkspace("w_project", "w_inbox");
        verify(workspaceMapper).delete("w_project");
    }

    @Test
    void cannotDeleteOthersWorkspace() {
        when(workspaceMapper.findByWorkspaceId("w_theirs")).thenReturn(workspace("w_theirs", "u_other", WorkspaceEntity.KIND_FOLDER));

        BizException error = assertThrows(BizException.class, () -> service.delete("u_me", "w_theirs"));
        assertEquals("WORKSPACE_002", error.getError().code());
    }

    @Test
    void replayingSameWorkspaceIdReturnsOriginal() {
        WorkspaceEntity existing = workspace("workspace_client", "u_me", WorkspaceEntity.KIND_FOLDER);
        when(workspaceMapper.findByWorkspaceId("workspace_client")).thenReturn(existing);

        assertSame(existing, service.create("u_me", "workspace_client", null, "阿钉", "/Users/me/ading"));
        verify(workspaceMapper, never()).insert(any());
    }

    private static WorkspaceEntity workspace(String id, String owner, String kind) {
        WorkspaceEntity workspace = new WorkspaceEntity();
        workspace.setWorkspaceId(id);
        workspace.setOwner(owner);
        workspace.setKind(kind);
        return workspace;
    }
}
