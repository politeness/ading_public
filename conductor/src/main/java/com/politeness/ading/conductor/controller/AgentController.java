package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.controller.dto.AgentRegisterRequest;
import com.politeness.ading.conductor.controller.dto.AgentSessionUpsertRequest;
import com.politeness.ading.conductor.controller.dto.AgentSessionView;
import com.politeness.ading.conductor.controller.dto.AgentUpdateRequest;
import com.politeness.ading.conductor.controller.dto.UserView;
import com.politeness.ading.conductor.dal.entity.AgentSessionEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.error.AgentError;
import com.politeness.ading.conductor.error.AuthError;
import com.politeness.ading.conductor.manager.TurnActivityBoard;
import com.politeness.ading.conductor.service.AgentService;
import com.politeness.ading.conductor.service.AgentStateService;
import com.politeness.ading.conductor.service.ConversationService;
import com.politeness.ading.conductor.service.NodeService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/agents")
public class AgentController {

    private final AgentService agentService;
    private final AgentStateService agentStateService;
    private final ConversationService conversationService;
    private final TurnActivityBoard activityBoard;
    private final NodeService nodeService;

    public AgentController(AgentService agentService, AgentStateService agentStateService, ConversationService conversationService,
                           TurnActivityBoard activityBoard, NodeService nodeService) {
        this.nodeService = nodeService;
        this.agentService = agentService;
        this.agentStateService = agentStateService;
        this.conversationService = conversationService;
        this.activityBoard = activityBoard;
    }

    /**
     * Same source as the "who is working" forwarded over MQTT, for mobile polling.
     * lines is this turn's latest activity feed (at most TurnActivityBoard.MAX_LINES lines), shown as the "in progress" section of the mobile activity feed
     */
    public record AgentActivityView(String conversationId, String agentUserId, List<String> lines) {}

    /** Agents under the account that are currently working: each item is "which agent in which conversation" plus its activity feed for this turn. Memory only; it disappears when the turn ends or after 30 seconds without a new report */
    @GetMapping("/activity")
    public Result<List<AgentActivityView>> activity() {
        String ownerUserId = AuthContext.get().userId();
        return Result.ok(activityBoard.activeFor(ownerUserId).stream()
                .map(activity -> new AgentActivityView(activity.conversationId, activity.agentUserId, activityBoard.linesOf(activity)))
                .toList());
    }

    /** The computer's node token (mobile terminal tokens get NODE_007). Idempotent for the same terminal_id + local_uuid; repeated registration returns the same user_id. */
    @PostMapping("/register")
    public Result<UserView> register(@Valid @RequestBody AgentRegisterRequest request) {
        Principal principal = requireExecutionNode();
        UserEntity agent = agentService.register(
                principal.terminalId(), principal.userId(), request.localUuid(),
                request.agentType(), request.agentVersion(), request.displayName());
        return Result.ok(UserView.from(agent));
    }

    @GetMapping
    public Result<List<UserView>> list() {
        String ownerUserId = AuthContext.get().userId();
        // Agents on all computers under the account, each with its computer, online status, and the readiness state published by that computer
        return Result.ok(agentService.listOwned(ownerUserId).stream().map(agentStateService::describeOwned).toList());
    }

    @GetMapping("/{userId}")
    public Result<UserView> get(@PathVariable String userId) {
        String ownerUserId = AuthContext.get().userId();
        return Result.ok(UserView.from(agentService.requireOwnedAgent(userId, ownerUserId)));
    }

    /** Mobile or another computer asks the computer hosting the target to re-check; this only confirms dispatch and does not pretend the check is done. */
    @PostMapping("/{userId}/verify")
    public Result<Boolean> verify(@PathVariable String userId) {
        agentService.requestStatusRefresh(userId, AuthContext.get().userId());
        return Result.ok(true);
    }

    /**
     * Change nickname / permissions / persona. Pushes an AGENT_UPDATED frame to the node hosting that agent.
     * PUT rather than PATCH: the semantics are "overwrite the mutable fields with this data", clearly idempotent.
     */
    @PutMapping("/{userId}")
    public Result<UserView> update(@PathVariable String userId,
                                   @Valid @RequestBody AgentUpdateRequest request) {
        String ownerUserId = AuthContext.get().userId();
        UserEntity agent = agentService.update(userId, ownerUserId,
                request.displayName(), request.permissionLevel(), request.persona());
        return Result.ok(UserView.from(agent));
    }

    /** Compatibility with old clients: PATCH is equivalent to PUT */
    @PatchMapping("/{userId}")
    public Result<UserView> patch(@PathVariable String userId,
                                  @Valid @RequestBody AgentUpdateRequest request) {
        return update(userId, request);
    }

    // ------------------------------------------------------------------
    // Conversation-level thread: unique key (conversation_id, user_id), never shared between conversations
    // ------------------------------------------------------------------

    @GetMapping("/{userId}/sessions/{conversationId}")
    public Result<AgentSessionView> getSession(@PathVariable String userId,
                                               @PathVariable String conversationId) {
        Principal principal = AuthContext.get();
        agentService.requireOwnedAgent(userId, principal.userId());
        conversationService.requireMember(conversationId, userId);
        AgentSessionEntity session = agentService.findSession(conversationId, userId);
        if (session == null) {
            // No thread created yet; return an empty shell so the desktop knows to create one
            return Result.ok(new AgentSessionView(conversationId, userId, null, null, "NEW"));
        }
        return Result.ok(AgentSessionView.from(session));
    }

    @PutMapping("/{userId}/sessions/{conversationId}")
    public Result<AgentSessionView> upsertSession(@PathVariable String userId,
                                                  @PathVariable String conversationId,
                                                  @Valid @RequestBody AgentSessionUpsertRequest request) {
        Principal principal = requireExecutionNode();
        agentService.requireOwnedAgent(userId, principal.userId());
        agentService.assertAgentOnNode(principal.terminalId(), userId);
        conversationService.requireMember(conversationId, userId);
        AgentSessionEntity session = agentService.upsertSession(
                conversationId, userId, request.providerThreadId(), request.workspacePath());
        return Result.ok(AgentSessionView.from(session));
    }

    /** Registering Agents and writing conversation threads are executor actions: only the computer's node token is accepted; mobile terminal tokens get NODE_007 */
    private Principal requireExecutionNode() {
        Principal principal = AuthContext.get();
        if (!principal.isNode()) {
            throw new BizException(AuthError.WRONG_TOKEN_TYPE, "This endpoint requires a node token");
        }
        if (principal.terminalId() == null) {
            throw new BizException(AgentError.NOT_ON_THIS_NODE);
        }
        nodeService.requireExecutionTerminal(principal.terminalId(), principal.userId());
        return principal;
    }
}
