package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.controller.dto.KnowledgeLockRenewView;
import com.politeness.ading.conductor.controller.dto.KnowledgeLockRequest;
import com.politeness.ading.conductor.controller.dto.KnowledgeLockView;
import com.politeness.ading.conductor.controller.dto.KnowledgeObjectView;
import com.politeness.ading.conductor.controller.dto.KnowledgeUrlsRequest;
import com.politeness.ading.conductor.controller.dto.KnowledgeUrlsView;
import com.politeness.ading.conductor.service.KnowledgeService;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * User skills and memory in the cloud. kind is skill or memory; only the token owner's own directory can be accessed, and files are transferred directly with OSS via signed URLs.
 * Multiple computers of the same user queue via the lock; writing to OSS requires holding the lock.
 */
@RestController
@RequestMapping("/api/v1/knowledge")
public class KnowledgeController {

    private final KnowledgeService knowledgeService;

    public KnowledgeController(KnowledgeService knowledgeService) {
        this.knowledgeService = knowledgeService;
    }

    @PostMapping("/lock")
    public Result<KnowledgeLockView> acquire() {
        return Result.ok(knowledgeService.acquireLock(AuthContext.get().userId()));
    }

    @PostMapping("/lock/renew")
    public Result<KnowledgeLockRenewView> renew(@RequestBody KnowledgeLockRequest request) {
        return Result.ok(knowledgeService.renewLock(AuthContext.get().userId(), request.token()));
    }

    @PostMapping("/lock/release")
    public Result<Void> release(@RequestBody KnowledgeLockRequest request) {
        knowledgeService.releaseLock(AuthContext.get().userId(), request.token());
        return Result.ok(null);
    }

    @GetMapping("/{kind}/objects")
    public Result<List<KnowledgeObjectView>> list(@PathVariable String kind) {
        return Result.ok(knowledgeService.list(AuthContext.get().userId(), kind));
    }

    @PostMapping("/{kind}/urls")
    public Result<KnowledgeUrlsView> urls(@PathVariable String kind, @RequestBody KnowledgeUrlsRequest request) {
        return Result.ok(knowledgeService.urls(AuthContext.get().userId(), kind, request));
    }
}
