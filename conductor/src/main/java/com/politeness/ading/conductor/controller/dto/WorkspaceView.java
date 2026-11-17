package com.politeness.ading.conductor.controller.dto;

import com.politeness.ading.conductor.common.Times;
import com.politeness.ading.conductor.dal.entity.WorkspaceEntity;
import java.time.Instant;

public record WorkspaceView(
        String workspaceId,
        String name,
        String path,
        String kind,
        String terminalId,
        Instant gmtCreated,
        Instant gmtModified) {

    public static WorkspaceView from(WorkspaceEntity workspace) {
        return new WorkspaceView(
                workspace.getWorkspaceId(),
                workspace.getName(),
                workspace.getPath(),
                workspace.getKind(),
                workspace.getTerminalId(),
                Times.instant(workspace.getGmtCreated()),
                Times.instant(workspace.getGmtModified()));
    }
}
