package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.controller.dto.WorkspaceCreateRequest;
import com.politeness.ading.conductor.controller.dto.WorkspaceUpdateRequest;
import com.politeness.ading.conductor.controller.dto.WorkspaceView;
import com.politeness.ading.conductor.service.WorkspaceService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Workspaces. Only your own account's can be seen and changed; the list always includes "No workspace" */
@RestController
@RequestMapping("/api/v1/workspaces")
public class WorkspaceController {

    private final WorkspaceService workspaceService;

    public WorkspaceController(WorkspaceService workspaceService) {
        this.workspaceService = workspaceService;
    }

    @GetMapping
    public Result<List<WorkspaceView>> list() {
        String userId = AuthContext.get().userId();
        return Result.ok(workspaceService.list(userId).stream().map(WorkspaceView::from).toList());
    }

    @PostMapping
    public Result<WorkspaceView> create(@Valid @RequestBody WorkspaceCreateRequest request) {
        Principal principal = AuthContext.get();
        String terminalId = principal.isNode() ? principal.terminalId() : request.terminalId();
        return Result.ok(WorkspaceView.from(workspaceService.create(
                principal.userId(), request.workspaceId(), terminalId, request.name(), request.path())));
    }

    @PutMapping("/{id}")
    public Result<WorkspaceView> update(@PathVariable String id,
                                        @RequestBody WorkspaceUpdateRequest request) {
        String userId = AuthContext.get().userId();
        return Result.ok(WorkspaceView.from(workspaceService.update(userId, id, request.name(), request.path())));
    }

    /** Conversations under it move to "No workspace"; deleting twice has the same result */
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable String id) {
        workspaceService.delete(AuthContext.get().userId(), id);
        return Result.ok();
    }
}
