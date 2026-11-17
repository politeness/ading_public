package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.controller.dto.PersonView;
import com.politeness.ading.conductor.controller.dto.UserView;
import com.politeness.ading.conductor.service.AgentService;
import com.politeness.ading.conductor.service.AgentStateService;
import com.politeness.ading.conductor.service.RelationService;
import com.politeness.ading.conductor.service.UserReportService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;
import java.util.Map;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Contacts. A contact is a friend relation (users_rel):
 * - Your own agents: not added as friends automatically on registration; the person decides by clicking in "Explore Silicon People", and a click makes it a contact directly;
 * - Real people: find the other person by username, email, or phone number, send a request, and become friends once they accept.
 * Agents are not interconnected by default: the friend list has no one else's agents, and you cannot add someone else's agent as a contact.
 */
@RestController
@RequestMapping("/api/v1/friends")
public class FriendController {

    private final RelationService relationService;
    private final AgentService agentService;
    private final AgentStateService agentStateService;
    private final UserReportService userReportService;

    public FriendController(RelationService relationService, AgentService agentService,
                            AgentStateService agentStateService, UserReportService userReportService) {
        this.relationService = relationService;
        this.agentService = agentService;
        this.agentStateService = agentStateService;
        this.userReportService = userReportService;
    }

    @GetMapping
    public Result<List<UserView>> list() {
        String userId = AuthContext.get().userId();
        // Agents carry their computer, online status, and the readiness state published by their computer; each client sets the traffic light from this
        return Result.ok(relationService.listFriends(userId).stream().map(agentStateService::describe).toList());
    }

    /** Add an agent you own as a contact. Adding repeatedly has the same result */
    @PostMapping("/{userId}")
    public Result<Void> add(@PathVariable String userId) {
        String owner = AuthContext.get().userId();
        agentService.requireOwnedAgent(userId, owner);
        relationService.befriend(owner, userId);
        // Contacts are shared across clients: other computers must refresh too to see the one just added
        agentStateService.notifyOwner(owner);
        return Result.ok();
    }

    /**
     * Remove a contact: only deletes the friend relation; the agent itself and the conversations and messages it took part in are kept. Deleting twice has the same result.
     * When removing a real-person friend, the other side refreshes too; the chat history with them is kept, but no more messages can be sent in the one-on-one chat.
     */
    @DeleteMapping("/{userId}")
    public Result<Void> remove(@PathVariable String userId) {
        String owner = AuthContext.get().userId();
        relationService.unfriend(owner, userId);
        agentStateService.notifyOwner(owner);
        relationService.notifyBoth(owner, userId);
        return Result.ok();
    }

    @GetMapping("/agent-shares")
    public Result<Map<String, List<String>>> agentShares() {
        return Result.ok(relationService.agentShares(AuthContext.get().userId()));
    }
    @PostMapping("/agents/{agentId}/shares/{recipientId}")
    public Result<Void> shareAgent(@PathVariable String agentId, @PathVariable String recipientId) {
        relationService.shareAgent(AuthContext.get().userId(), agentId, recipientId, true);
        return Result.ok();
    }
    @DeleteMapping("/agents/{agentId}/shares/{recipientId}")
    public Result<Void> revokeAgent(@PathVariable String agentId, @PathVariable String recipientId) {
        relationService.shareAgent(AuthContext.get().userId(), agentId, recipientId, false);
        return Result.ok();
    }

    /** Find people by exact username, email, or phone number (real people only); results include their relation to me */
    @GetMapping("/search")
    public Result<List<PersonView>> search(@RequestParam("q") String query) {
        return Result.ok(relationService.search(AuthContext.get().userId(), query));
    }

    /** Friend requests received and sent that are still pending */
    @GetMapping("/requests")
    public Result<List<PersonView>> requests() {
        return Result.ok(relationService.listRequests(AuthContext.get().userId()));
    }

    /** Request to add the other person as a friend; if they already requested me, we become friends directly. Returns the relation after the request */
    @PostMapping("/requests/{userId}")
    public Result<Map<String, String>> request(@PathVariable String userId) {
        String relation = relationService.request(AuthContext.get().userId(), userId);
        return Result.ok(Map.of("relation", relation));
    }

    /** Accept the other person's request */
    @PostMapping("/requests/{userId}/accept")
    public Result<Void> accept(@PathVariable String userId) {
        relationService.accept(AuthContext.get().userId(), userId);
        return Result.ok();
    }

    // ---- Block and report: real people only -------------------------------------------

    /** Block: both sides are no longer friends, the other side cannot request to add me again, and cannot send messages in the one-on-one chat */
    @PostMapping("/{userId}/block")
    public Result<Void> block(@PathVariable String userId) {
        relationService.block(AuthContext.get().userId(), userId);
        return Result.ok();
    }

    /** Unblock; does not restore the friend relation */
    @DeleteMapping("/{userId}/block")
    public Result<Void> unblock(@PathVariable String userId) {
        relationService.unblock(AuthContext.get().userId(), userId);
        return Result.ok();
    }

    /** People I have blocked */
    @GetMapping("/blocked")
    public Result<List<UserView>> blocked() {
        return Result.ok(relationService.listBlocked(AuthContext.get().userId()).stream().map(UserView::from).toList());
    }

    public record ReportRequest(@NotBlank String reason, @Size(max = 500) String detail, String conversationId) {}

    /** Report: compiled into a report for the developer to handle (uploaded to OSS + email); if conversationId is given, the reported person's recent messages in it are attached */
    @PostMapping("/{userId}/report")
    public Result<Void> report(@PathVariable String userId, @Valid @RequestBody ReportRequest request) {
        userReportService.report(AuthContext.get().userId(), userId, request.reason(), request.detail(), request.conversationId());
        return Result.ok();
    }

    /** Decline the other person's request, or withdraw a request I sent */
    @DeleteMapping("/requests/{userId}")
    public Result<Void> dismiss(@PathVariable String userId) {
        relationService.dismissRequest(AuthContext.get().userId(), userId);
        return Result.ok();
    }
}
