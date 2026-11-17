package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.AgentSessionEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.AgentSessionMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.AgentError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class AgentService {

    private static final Set<String> AGENT_TYPES =
            Set.of("CODEX", "CLAUDE_CODE", "QODER", "QODER_CN", "QWEN_CODE", "KIRO", "COPILOT", "ANTIGRAVITY");
    private static final Set<String> PERMISSION_LEVELS =
            Set.of("READ_ONLY", "ASK_EVERY_TIME", "ALWAYS_ALLOW");
    private static final int MAX_DISPLAY_NAME = 30;

    private final UserMapper userMapper;
    private final AgentSessionMapper agentSessionMapper;
    private final RelationService relationService;
    private final NodeRegistry nodeRegistry;
    private final IdGenerator idGenerator;

    public AgentService(UserMapper userMapper,
                        AgentSessionMapper agentSessionMapper,
                        RelationService relationService,
                        NodeRegistry nodeRegistry,
                        IdGenerator idGenerator) {
        this.userMapper = userMapper;
        this.agentSessionMapper = agentSessionMapper;
        this.relationService = relationService;
        this.nodeRegistry = nodeRegistry;
        this.idGenerator = idGenerator;
    }

    /**
     * Register a local agent.
     *
     * The idempotency key is (terminal_id, local_uuid): desktop re-runs discoverLocalAgents() on every launch;
     * without idempotency your codex would become a new employee on every restart.
     *
     * The local identifier is "type@computer UUID", and each computer has only one Agent per type. So when the identifier isn't found,
     * the one of the same type (same identifier prefix) on the same computer is it — if the identifier rule changes (e.g. from "type@hostname"
     * to "type@computer UUID") or the hostname changes, it is switched to the new identifier in place instead of creating a new Agent.
     */
    @Transactional
    public UserEntity register(String terminalId, String ownerUserId, String localUuid,
                               String agentType, String agentVersion, String displayName) {
        String normalizedType = agentType == null ? "" : agentType.toUpperCase(Locale.ROOT);
        if (!AGENT_TYPES.contains(normalizedType)) {
            throw new BizException(AgentError.UNSUPPORTED_TYPE);
        }
        UserEntity existing = userMapper.findAgentByTerminalAndLocalUuid(terminalId, localUuid);
        if (existing == null) {
            existing = sameKindOnTerminal(terminalId, localUuid);
            if (existing != null) {
                userMapper.updateAgentLocalUuid(terminalId, existing.getUserId(), localUuid);
                log.info("Agent local identifier changed userId={} terminalId={} from={} to={}",
                        existing.getUserId(), terminalId, existing.getLocalUuid(), localUuid);
                existing.setLocalUuid(localUuid);
            }
        }
        if (existing != null) {
            return withVersion(existing, agentVersion);
        }

        UserEntity agent = new UserEntity();
        agent.setUserId(idGenerator.userId());
        agent.setUsername(buildUsername(normalizedType, agent.getUserId()));
        agent.setDisplayName(displayName == null || displayName.isBlank()
                ? defaultDisplayName(normalizedType) : displayName.trim());
        agent.setIsAgent(true);
        agent.setPassword(null);
        agent.setStatus(UserEntity.STATUS_ACTIVE);
        agent.setAgentType(normalizedType);
        agent.setAgentVersion(agentVersion);
        agent.setPermissionLevel("READ_ONLY");
        agent.setOwner(ownerUserId);
        // An Agent belongs to exactly one computer: its computer and local identifier are recorded on the Agent itself
        agent.setTerminalId(terminalId);
        agent.setLocalUuid(localUuid);
        agent.setReadiness("unknown");
        try {
            userMapper.insert(agent);
        } catch (DuplicateKeyException collision) {
            // Startup and discovery may register the same CLI concurrently.
            // A normal SELECT can still see the earlier repeatable-read snapshot.
            UserEntity winner = userMapper.findRegisteredAgentForUpdate(terminalId, localUuid);
            if (winner == null || !ownerUserId.equals(winner.getOwner())
                    || !normalizedType.equals(winner.getAgentType())) throw collision;
            // The loser may carry the newer version (a CLI upgrade between startup and discovery).
            return withVersion(winner, agentVersion);
        }

        // No automatic friending: contacts are friend relationships, and whether to add is up to the person in "Explore Agents".
        // Agents you own can be added to conversations without being friends, see ConversationService.requireCanJoin
        return agent;
    }

    /** When a registered Agent brings a different version, write it back; shared by the normal re-register path and the concurrent-register key-collision path */
    private UserEntity withVersion(UserEntity agent, String agentVersion) {
        if (agentVersion != null && !agentVersion.equals(agent.getAgentVersion())) {
            UserEntity patch = new UserEntity();
            patch.setUserId(agent.getUserId());
            patch.setAgentVersion(agentVersion);
            userMapper.updateAgentProfile(patch);
            agent.setAgentVersion(agentVersion);
        }
        return agent;
    }

    private UserEntity sameKindOnTerminal(String terminalId, String localUuid) {
        int at = localUuid.indexOf('@');
        if (at <= 0) return null;
        String prefix = localUuid.substring(0, at + 1);
        return userMapper.findAgentsByTerminal(terminalId).stream()
                .filter(agent -> agent.getLocalUuid() != null && agent.getLocalUuid().startsWith(prefix))
                .findFirst()
                .orElse(null);
    }

    public List<UserEntity> listOwned(String ownerUserId) {
        return userMapper.findAgentsByOwner(ownerUserId);
    }

    public UserEntity requireOwnedAgent(String agentUserId, String ownerUserId) {
        UserEntity agent = userMapper.findByUserId(agentUserId);
        if (agent == null || !Boolean.TRUE.equals(agent.getIsAgent())) {
            throw new BizException(AgentError.AGENT_NOT_FOUND);
        }
        if (!ownerUserId.equals(agent.getOwner())) {
            throw new BizException(AgentError.NOT_AGENT_OWNER);
        }
        return agent;
    }

    /** The owner or users with shared-use permission may request a check; only the target's computer is notified. */
    public void requestStatusRefresh(String agentUserId, String requesterUserId) {
        UserEntity agent = userMapper.findByUserId(agentUserId);
        if (agent == null || !Boolean.TRUE.equals(agent.getIsAgent())) {
            throw new BizException(AgentError.AGENT_NOT_FOUND);
        }
        if (!requesterUserId.equals(agent.getOwner()) && !relationService.canUseAgent(requesterUserId, agent)) {
            throw new BizException(AgentError.NOT_AGENT_OWNER);
        }
        if (agent.getTerminalId() == null || !nodeRegistry.isOnline(agentUserId)) {
            throw new BizException(AgentError.AGENT_OFFLINE);
        }
        nodeRegistry.sendToUser(agentUserId,
                NodeFrame.of(FrameType.AGENT_VERIFY_REQUEST, Map.of("agentUserId", agentUserId)));
    }

    /**
     * Change nickname / permissions / persona.
     *
     * Side effect: pushes an AGENT_UPDATED frame to the agent's node.
     * Permissions are stored server-side but cached and enforced locally by desktop — checking over HTTP every time an agent speaks is too heavy,
     * and it couldn't work if the backend went down. This path is also the first real use of the NodeRegistry channel.
     */
    @Transactional
    public UserEntity update(String agentUserId, String ownerUserId,
                             String displayName, String permissionLevel, String persona) {
        UserEntity agent = requireOwnedAgent(agentUserId, ownerUserId);

        if (displayName != null) {
            String trimmed = displayName.trim();
            if (trimmed.isEmpty()) {
                throw new BizException(AgentError.DISPLAY_NAME_BLANK);
            }
            if (trimmed.length() > MAX_DISPLAY_NAME) {
                throw new BizException(AgentError.DISPLAY_NAME_TOO_LONG);
            }
            agent.setDisplayName(trimmed);
        }
        if (permissionLevel != null) {
            String normalized = permissionLevel.toUpperCase(Locale.ROOT);
            if (!PERMISSION_LEVELS.contains(normalized)) {
                throw new BizException(AgentError.BAD_PERMISSION_LEVEL);
            }
            agent.setPermissionLevel(normalized);
        }
        if (persona != null) {
            agent.setPersona(persona);
        }

        UserEntity patch = new UserEntity();
        patch.setUserId(agent.getUserId());
        patch.setDisplayName(displayName == null ? null : agent.getDisplayName());
        patch.setPermissionLevel(permissionLevel == null ? null : agent.getPermissionLevel());
        patch.setPersona(persona);
        userMapper.updateAgentProfile(patch);

        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("agentUserId", agent.getUserId());
        payload.put("displayName", agent.getDisplayName());
        payload.put("permissionLevel", agent.getPermissionLevel());
        payload.put("persona", agent.getPersona());
        nodeRegistry.sendToUser(agent.getUserId(), NodeFrame.of(FrameType.AGENT_UPDATED, payload));
        // Nickname and persona are contact profile data shared across clients: other computers of the same account must refresh too
        nodeRegistry.sendToUser(agent.getOwner(), NodeFrame.of(FrameType.AGENTS_CHANGED, Map.of()));

        return agent;
    }

    // ------------------------------------------------------------------
    // Per-conversation thread — each conversation has its own thread, never shared between conversations
    // ------------------------------------------------------------------

    public AgentSessionEntity findSession(String conversationId, String agentUserId) {
        return agentSessionMapper.find(conversationId, agentUserId);
    }

    @Transactional
    public AgentSessionEntity upsertSession(String conversationId, String agentUserId,
                                            String providerThreadId, String workspacePath) {
        AgentSessionEntity session = agentSessionMapper.find(conversationId, agentUserId);
        if (session == null) {
            session = new AgentSessionEntity();
            session.setSessionId(idGenerator.sessionId());
            session.setConversationId(conversationId);
            session.setUserId(agentUserId);
        }
        if (providerThreadId != null) {
            session.setProviderThreadId(providerThreadId);
        }
        if (workspacePath != null) {
            session.setWorkspacePath(workspacePath);
        }
        session.setStatus(AgentSessionEntity.STATUS_ACTIVE);
        agentSessionMapper.upsert(session);
        return session;
    }

    public void assertAgentOnNode(String terminalId, String agentUserId) {
        if (terminalId == null || !terminalId.equals(userMapper.findTerminalIdOfAgent(agentUserId))) {
            throw new BizException(AgentError.NOT_ON_THIS_NODE);
        }
    }

    private String buildUsername(String agentType, String userId) {
        String suffix = userId.length() > 8 ? userId.substring(userId.length() - 8) : userId;
        return agentType.toLowerCase(Locale.ROOT).replace('_', '-') + "-" + suffix.toLowerCase(Locale.ROOT);
    }

    private String defaultDisplayName(String agentType) {
        return switch (agentType) {
            case "CODEX"       -> "Codex";
            case "CLAUDE_CODE" -> "Claude";
            case "QODER"       -> "Qoder";
            case "QODER_CN"    -> "Qoder CN";
            case "QWEN_CODE"   -> "Qwen Code";
            case "KIRO" -> "Kiro";
            case "COPILOT" -> "GitHub Copilot";
            case "ANTIGRAVITY" -> "Antigravity";
            default            -> "Agent";
        };
    }
}
