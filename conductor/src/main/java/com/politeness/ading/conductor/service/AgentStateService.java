package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.controller.dto.AgentModelState;
import com.politeness.ading.conductor.controller.dto.AgentStateReport;
import com.politeness.ading.conductor.controller.dto.UserView;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.error.CommonError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import com.politeness.ading.conductor.manager.PresenceUnknownException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.ObjectMapper;

/**
 * Agent state sync.
 *
 * The principle of cross-computer collaboration is "sync across clients": a synced message is equivalent to being typed on that computer; agent state syncs the same way.
 * Each computer publishes its own agents' state; this only stores it and notifies the account's other computers on change, **making no judgments** —
 * how to light green and how to handle red is computed by each client with the same rules as the offline version.
 */
@Slf4j
@Service
public class AgentStateService {

    private final AgentShareAudience shareAudience;

    /** Matches desktop AgentReadiness. Unknown values are not stored, so clients never interpret the same word differently */
    private static final Set<String> READINESS =
            Set.of("unknown", "missing", "found", "unauthorized", "ready", "exhausted", "error");

    private static final ObjectMapper JSON = new ObjectMapper();

    private final UserMapper userMapper;
    private final TerminalMapper terminalMapper;
    private final NodeRegistry nodeRegistry;

    public AgentStateService(UserMapper userMapper,
                             TerminalMapper terminalMapper,
                             NodeRegistry nodeRegistry) {
        this(userMapper, terminalMapper, nodeRegistry, null);
    }

    @org.springframework.beans.factory.annotation.Autowired
    public AgentStateService(UserMapper userMapper, TerminalMapper terminalMapper, NodeRegistry nodeRegistry, AgentShareAudience shareAudience) {
        this.userMapper = userMapper;
        this.terminalMapper = terminalMapper;
        this.nodeRegistry = nodeRegistry;
        this.shareAudience = shareAudience;
    }

    /**
     * A computer publishes its own agents' state (readiness, version). Only that computer's own agents are accepted;
     * on change, the account's other computers are notified to re-fetch.
     *
     * Entries not belonging to this computer are skipped rather than rejecting the whole batch: an agent discovered while offline may not be registered in the cloud yet
     * and uses a local ID; one such agent must not block the state of all others. Skipping writes nothing,
     * so the permission boundary is unchanged. Unknown values reject the whole batch — that's a client bug and should surface early.
     *
     * @return how many actually changed
     */
    @Transactional
    public int publish(String terminalId, String ownerUserId, List<AgentStateReport.Item> items) {
        // Validate everything before writing; never leave a half-written state
        List<AgentStateReport.Item> changed = new ArrayList<>();
        List<String> skipped = new ArrayList<>();
        for (AgentStateReport.Item item : items) {
            if (!READINESS.contains(item.readiness())) {
                throw new BizException(CommonError.BAD_REQUEST, "Unknown readiness state: " + item.readiness());
            }
            UserEntity agent = userMapper.findByUserId(item.userId());
            if (agent == null || !Boolean.TRUE.equals(agent.getIsAgent()) || !terminalId.equals(agent.getTerminalId())) {
                skipped.add(item.userId());
                continue;
            }
            boolean versionChanged = item.agentVersion() != null && !item.agentVersion().isBlank()
                    && !item.agentVersion().equals(agent.getAgentVersion());
            boolean modelChanged = item.model() != null && !JSON.writeValueAsString(item.model()).equals(agent.getModelState());
            if (!item.readiness().equals(agent.getReadiness()) || versionChanged || modelChanged) changed.add(item);
        }
        if (!skipped.isEmpty()) {
            log.warn("Skipping agent state not owned by this computer terminalId={} userIds={}", terminalId, skipped);
        }
        for (AgentStateReport.Item item : changed) {
            String version = item.agentVersion() == null || item.agentVersion().isBlank() ? null : item.agentVersion();
            String model = item.model() == null ? null : JSON.writeValueAsString(item.model());
            userMapper.updateAgentState(terminalId, item.userId(), item.readiness(), version, model);
        }
        if (!changed.isEmpty()) {
            if (shareAudience != null) shareAudience.changed(ownerUserId);
            else nodeRegistry.sendToUser(ownerUserId, NodeFrame.of(FrameType.AGENTS_CHANGED, Map.of()));
        }
        return changed.size();
    }

    /**
     * Contacts or agent profiles under the account changed (contacts added/removed, renamed, persona or permissions changed):
     * notify all online computers of this account to re-fetch. Contacts are shared across clients, so these changes sync to every client just like messages.
     */
    public void notifyOwner(String ownerUserId) {
        if (ownerUserId == null) return;
        if (shareAudience != null) shareAudience.changed(ownerUserId);
        else nodeRegistry.sendToUser(ownerUserId, NodeFrame.of(FrameType.AGENTS_CHANGED, Map.of()));
    }

    /** Agent with its computer, whether that computer is online, and the state it published, passed to the client as-is */
    public UserView describe(UserEntity user) {
        UserView view = UserView.from(user);
        if (!view.isAgent()) return view;
        TerminalEntity terminal = user.getTerminalId() == null ? null : terminalMapper.findByTerminalId(user.getTerminalId());
        if (terminal == null) return view;
        Boolean online;
        try { online = nodeRegistry.isTerminalOnline(terminal.getTerminalId()); }
        catch (PresenceUnknownException unknown) { online = null; }
        return view.withComputer(terminal.getTerminalId(), terminal.getName(), online, user.getReadiness());
    }

    /** The owner viewing their own agent: includes the current model. Borrowers go through describe and can neither see nor set it */
    public UserView describeOwned(UserEntity user) {
        UserView view = describe(user);
        if (user.getModelState() == null) return view;
        try { return view.withModel(JSON.readValue(user.getModelState(), AgentModelState.class)); }
        catch (JacksonException malformed) {
            log.warn("Failed to parse agent model state userId={}", user.getUserId());
            return view;
        }
    }
}
