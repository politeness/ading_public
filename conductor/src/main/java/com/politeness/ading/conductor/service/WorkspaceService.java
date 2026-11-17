package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.WorkspaceEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.dal.mapper.WorkspaceMapper;
import com.politeness.ading.conductor.error.WorkspaceError;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Workspaces. Same rules as the standalone edition's LocalStore:
 * each account has one "No workspace" that cannot be deleted; when a workspace is deleted, its conversations move to "No workspace" instead of being deleted.
 */
@Service
public class WorkspaceService {

    /** Client-generated business ID: created locally while offline and uploaded unchanged once online, so replay does not create duplicates */
    static final Pattern CLIENT_ID = Pattern.compile("^[A-Za-z0-9_:.-]{1,64}$");
    private static final int MAX_NAME = 100;
    private static final int MAX_PATH = 1024;

    private final WorkspaceMapper workspaceMapper;
    private final ConversationMapper conversationMapper;
    private final UserMapper userMapper;
    private final NodeService nodeService;
    private final IdGenerator idGenerator;

    public WorkspaceService(WorkspaceMapper workspaceMapper,
                            ConversationMapper conversationMapper,
                            UserMapper userMapper,
                            NodeService nodeService,
                            IdGenerator idGenerator) {
        this.workspaceMapper = workspaceMapper;
        this.conversationMapper = conversationMapper;
        this.userMapper = userMapper;
        this.nodeService = nodeService;
        this.idGenerator = idGenerator;
    }

    @Transactional
    public List<WorkspaceEntity> list(String ownerUserId) {
        ensureInbox(ownerUserId);
        return workspaceMapper.listByOwner(ownerUserId);
    }

    /** Creates "No workspace" on first use. Locks the account row so concurrent requests create only one */
    @Transactional
    public WorkspaceEntity ensureInbox(String ownerUserId) {
        userMapper.lockByUserId(ownerUserId);
        WorkspaceEntity inbox = workspaceMapper.findInbox(ownerUserId);
        if (inbox != null) {
            return inbox;
        }
        inbox = new WorkspaceEntity();
        inbox.setWorkspaceId(idGenerator.workspaceId());
        inbox.setOwner(ownerUserId);
        inbox.setName(WorkspaceEntity.INBOX_NAME);
        inbox.setKind(WorkspaceEntity.KIND_INBOX);
        workspaceMapper.insert(inbox);
        return workspaceMapper.findByWorkspaceId(inbox.getWorkspaceId());
    }

    /** Used when creating a conversation: with no workspace specified, it goes into "No workspace" */
    @Transactional
    public WorkspaceEntity resolveForConversation(String ownerUserId, String workspaceId) {
        if (workspaceId == null || workspaceId.isBlank()) {
            return ensureInbox(ownerUserId);
        }
        return requireOwned(ownerUserId, workspaceId);
    }

    @Transactional
    public WorkspaceEntity create(String ownerUserId, String workspaceId, String terminalId,
                                  String name, String path) {
        if (workspaceId != null) {
            if (!CLIENT_ID.matcher(workspaceId).matches()) {
                throw new BizException(WorkspaceError.BAD_ID);
            }
            WorkspaceEntity existing = workspaceMapper.findByWorkspaceId(workspaceId);
            if (existing != null) {
                if (!ownerUserId.equals(existing.getOwner())) {
                    throw new BizException(WorkspaceError.ID_CONFLICT);
                }
                return existing;
            }
        }
        if (terminalId != null && !terminalId.isBlank()) {
            // The workspace path is on the Agent's computer, so it can only be bound to a computer
            nodeService.requireExecutionTerminal(terminalId, ownerUserId);
        }
        WorkspaceEntity workspace = new WorkspaceEntity();
        workspace.setWorkspaceId(workspaceId == null ? idGenerator.workspaceId() : workspaceId);
        workspace.setOwner(ownerUserId);
        workspace.setTerminalId(terminalId == null || terminalId.isBlank() ? null : terminalId);
        workspace.setName(normalizeName(name));
        workspace.setPath(normalizePath(path));
        workspace.setKind(WorkspaceEntity.KIND_FOLDER);
        workspaceMapper.insert(workspace);
        return workspaceMapper.findByWorkspaceId(workspace.getWorkspaceId());
    }

    @Transactional
    public WorkspaceEntity update(String ownerUserId, String workspaceId, String name, String path) {
        WorkspaceEntity workspace = requireOwned(ownerUserId, workspaceId);
        if (path != null && WorkspaceEntity.KIND_INBOX.equals(workspace.getKind())) {
            throw new BizException(WorkspaceError.INBOX_HAS_NO_PATH);
        }
        workspaceMapper.update(workspaceId,
                name == null ? null : normalizeName(name),
                path == null ? null : normalizePath(path));
        return workspaceMapper.findByWorkspaceId(workspaceId);
    }

    /** Deleting twice gives the same result: a second delete during offline replay does not error */
    @Transactional
    public void delete(String ownerUserId, String workspaceId) {
        WorkspaceEntity workspace = workspaceMapper.findByWorkspaceId(workspaceId);
        if (workspace == null) {
            return;
        }
        if (!ownerUserId.equals(workspace.getOwner())) {
            throw new BizException(WorkspaceError.NOT_WORKSPACE_OWNER);
        }
        if (WorkspaceEntity.KIND_INBOX.equals(workspace.getKind())) {
            throw new BizException(WorkspaceError.INBOX_NOT_DELETABLE);
        }
        WorkspaceEntity inbox = ensureInbox(ownerUserId);
        // Conversations are not deleted along with it: chat history belongs to people and should not be wiped by a directory cleanup
        conversationMapper.moveWorkspace(workspaceId, inbox.getWorkspaceId());
        workspaceMapper.delete(workspaceId);
    }

    public WorkspaceEntity requireOwned(String ownerUserId, String workspaceId) {
        WorkspaceEntity workspace = workspaceMapper.findByWorkspaceId(workspaceId);
        if (workspace == null) {
            throw new BizException(WorkspaceError.WORKSPACE_NOT_FOUND);
        }
        if (!ownerUserId.equals(workspace.getOwner())) {
            throw new BizException(WorkspaceError.NOT_WORKSPACE_OWNER);
        }
        return workspace;
    }

    private static String normalizeName(String name) {
        String trimmed = name == null ? "" : name.trim();
        if (trimmed.isEmpty()) {
            throw new BizException(WorkspaceError.NAME_BLANK);
        }
        if (trimmed.length() > MAX_NAME) {
            throw new BizException(WorkspaceError.NAME_TOO_LONG);
        }
        return trimmed;
    }

    private static String normalizePath(String path) {
        String trimmed = path == null ? "" : path.trim();
        if (trimmed.isEmpty()) {
            throw new BizException(WorkspaceError.PATH_BLANK);
        }
        if (trimmed.length() > MAX_PATH) {
            throw new BizException(WorkspaceError.PATH_TOO_LONG);
        }
        return trimmed;
    }
}
