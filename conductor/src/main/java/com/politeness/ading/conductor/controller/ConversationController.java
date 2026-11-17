package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.JsonText;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.Times;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.controller.dto.MemberAddRequest;
import com.politeness.ading.conductor.controller.dto.MemberUpdateRequest;
import com.politeness.ading.conductor.controller.dto.MemberView;
import com.politeness.ading.conductor.controller.dto.MessageView;
import com.politeness.ading.conductor.controller.dto.ConversationCreateRequest;
import com.politeness.ading.conductor.controller.dto.ConversationUpdateRequest;
import com.politeness.ading.conductor.controller.dto.ConversationView;
import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.entity.ConversationUserRelEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.service.MessageService;
import com.politeness.ading.conductor.service.ConversationService;
import jakarta.validation.Valid;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/conversations")
public class ConversationController {

    private final ConversationService conversationService;
    private final MessageService messageService;

    public ConversationController(ConversationService conversationService,
                                  MessageService messageService) {
        this.conversationService = conversationService;
        this.messageService = messageService;
    }

    /** Each create makes an independent conversation; the same members can handle several things at once. Replaying with a conversationId returns the original conversation */
    @PostMapping
    public Result<ConversationView> create(@Valid @RequestBody ConversationCreateRequest request) {
        String userId = AuthContext.get().userId();
        List<ConversationService.MemberSpec> members = request.members() == null
                ? null
                : request.members().stream()
                        .map(member -> new ConversationService.MemberSpec(member.userId(), member.role()))
                        .toList();
        ConversationEntity conversation = conversationService.create(userId, new ConversationService.CreateCommand(
                request.conversationId(), request.type(), request.name(), request.memberIds(), members,
                request.workspaceId(), request.autoTitle(), request.seedKey(), JsonText.of(request.extra())));
        return Result.ok(toView(conversation, userId));
    }

    /** The desktop fetches everything at once on startup, so the list includes members too */
    @GetMapping
    public Result<List<ConversationView>> list(
            @RequestParam(defaultValue = "20") int limit) {
        String userId = AuthContext.get().userId();
        List<ConversationView> views = new ArrayList<>();
        for (ConversationEntity conversation : conversationService.list(userId, limit)) {
            views.add(toView(conversation, userId));
        }
        return Result.ok(views);
    }

    @GetMapping("/{id}")
    public Result<ConversationView> get(@PathVariable String id) {
        String userId = AuthContext.get().userId();
        ConversationEntity conversation = conversationService.requireAccessible(id, userId);
        return Result.ok(toView(conversation, userId));
    }

    @GetMapping("/sync-cursors")
    public Result<List<com.politeness.ading.conductor.dal.mapper.ConversationMapper.SyncCursor>> syncCursors(
            @RequestParam(defaultValue = "0") long afterId, @RequestParam(defaultValue = "1000") int limit) {
        return Result.ok(conversationService.syncCursors(AuthContext.get().userId(), afterId, limit));
    }

    @PutMapping("/{id}")
    public Result<ConversationView> update(@PathVariable String id,
                                           @RequestBody ConversationUpdateRequest request) {
        String userId = AuthContext.get().userId();
        ConversationEntity conversation = conversationService.updateMutable(id, userId, new ConversationService.UpdateCommand(
                request.name(), request.owner(), request.workspaceId(), request.status(),
                request.paused(), request.autoTitle(), JsonText.of(request.extra()),
                !Boolean.FALSE.equals(request.touch())));
        return Result.ok(toView(conversation, userId));
    }

    /** Compatibility with old clients: PATCH is equivalent to PUT */
    @PatchMapping("/{id}")
    public Result<ConversationView> patch(@PathVariable String id,
                                          @RequestBody ConversationUpdateRequest request) {
        return update(id, request);
    }

    /** Soft delete; deleting twice has the same result */
    @DeleteMapping("/{id}")
    public Result<Void> delete(@PathVariable String id) {
        conversationService.delete(id, AuthContext.get().userId());
        return Result.ok();
    }

    @PostMapping("/{id}/members")
    public Result<Void> addMember(@PathVariable String id,
                                  @Valid @RequestBody MemberAddRequest request) {
        String userId = AuthContext.get().userId();
        conversationService.addMember(id, userId, request.userId(), request.role());
        return Result.ok();
    }

    @PutMapping("/{id}/members/{memberId}")
    public Result<Void> updateMember(@PathVariable String id, @PathVariable String memberId,
                                     @RequestBody MemberUpdateRequest request) {
        String userId = AuthContext.get().userId();
        conversationService.updateMember(id, userId, memberId,
                request.role(), request.paused(), request.resumeOnContinue());
        return Result.ok();
    }

    @PutMapping("/{id}/owner-pause")
    public Result<Void> setOwnerPaused(@PathVariable String id, @RequestBody java.util.Map<String, Boolean> request) {
        conversationService.setOwnerPaused(id, AuthContext.get().userId(), Boolean.TRUE.equals(request.get("paused")));
        return Result.ok();
    }

    @DeleteMapping("/{id}/members/{memberId}")
    public Result<Void> removeMember(@PathVariable String id, @PathVariable String memberId) {
        String userId = AuthContext.get().userId();
        conversationService.removeMember(id, userId, memberId);
        return Result.ok();
    }

    private ConversationView toView(ConversationEntity conversation, String viewerId) {
        String conversationId = conversation.getConversationId();
        return new ConversationView(
                conversationId,
                conversation.getName(),
                conversation.getType(),
                conversationService.isSharedView(conversationId, viewerId),
                conversation.getCreator(),
                conversation.getOwner(),
                conversation.getState(),
                conversation.getLastSeq() == null ? 0L : conversation.getLastSeq(),
                conversationService.unreadCount(conversationId, viewerId),
                MessageView.from(messageService.latest(conversationId)),
                buildMembers(conversationId),
                // Workspaces belong to each person: a conversation someone else added me to goes under "No workspace" on my side
                viewerId.equals(conversation.getCreator()) ? conversation.getWorkspaceId() : null,
                conversation.getStatus(),
                Boolean.TRUE.equals(conversation.getPaused()),
                Boolean.TRUE.equals(conversation.getAutoTitle()),
                conversation.getSeedKey(),
                conversation.getExtra(),
                Times.instant(conversation.getGmtCreated()),
                Times.instant(conversation.getGmtModified()));
    }

    private List<MemberView> buildMembers(String conversationId) {
        List<ConversationUserRelEntity> rels = conversationService.members(conversationId);
        Map<String, UserEntity> byId = new HashMap<>();
        for (UserEntity user : conversationService.memberUsers(conversationId)) {
            byId.put(user.getUserId(), user);
        }
        List<MemberView> members = new ArrayList<>();
        for (ConversationUserRelEntity rel : rels) {
            UserEntity user = byId.get(rel.getUserId());
            members.add(new MemberView(
                    rel.getUserId(),
                    user == null ? rel.getUserId() : user.getDisplayName(),
                    user != null && Boolean.TRUE.equals(user.getIsAgent()),
                    rel.getRole(),
                    rel.getLastReadSeq() == null ? 0L : rel.getLastReadSeq(),
                    rel.getLastProcessedSeq(),
                    rel.getFirstUnreadMentionSeq(),
                    Boolean.TRUE.equals(rel.getPaused()),
                    Boolean.TRUE.equals(rel.getResumeOnContinue()),
                    Boolean.TRUE.equals(rel.getOwnerPaused())));
        }
        return members;
    }
}
