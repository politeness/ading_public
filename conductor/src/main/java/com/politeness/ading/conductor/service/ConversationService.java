package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.entity.ConversationUserRelEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.MessageError;
import com.politeness.ading.conductor.error.ConversationError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class ConversationService {

    private static final Set<String> ROLES = Set.of(
            ConversationUserRelEntity.ROLE_LEADER,
            ConversationUserRelEntity.ROLE_ENGINEER,
            ConversationUserRelEntity.ROLE_REVIEWER,
            ConversationUserRelEntity.ROLE_OBSERVER);
    private static final Set<String> STATUSES = Set.of(
            ConversationEntity.STATUS_ACTIVE,
            ConversationEntity.STATUS_DONE,
            ConversationEntity.STATUS_ARCHIVED);
    /** Client-generated business ID: created locally while offline and uploaded unchanged once online, so replays don't create duplicates */
    static final Pattern CLIENT_ID = Pattern.compile("^[A-Za-z0-9_:.-]{1,64}$");
    private static final int MAX_LIST = 1000;

    private final ConversationMapper conversationMapper;
    private final ConversationUserRelMapper memberMapper;
    private final UserMapper userMapper;
    private final RelationService relationService;
    private final NodeRegistry nodeRegistry;
    private final IdGenerator idGenerator;
    private final WorkspaceService workspaceService;

    public ConversationService(ConversationMapper conversationMapper,
                       ConversationUserRelMapper memberMapper,
                       UserMapper userMapper,
                       RelationService relationService,
                       NodeRegistry nodeRegistry,
                       IdGenerator idGenerator,
                       WorkspaceService workspaceService) {
        this.conversationMapper = conversationMapper;
        this.memberMapper = memberMapper;
        this.userMapper = userMapper;
        this.relationService = relationService;
        this.nodeRegistry = nodeRegistry;
        this.idGenerator = idGenerator;
        this.workspaceService = workspaceService;
    }

    /** A member and their role in the conversation; when role is null it is assigned by the default rules */
    public record MemberSpec(String userId, String role) {
    }

    /**
     * Parameters for creating a conversation.
     *
     * Roles on members are saved as-is: who is Leader is decided by the desktop scheduling rules (shared by standalone and online versions);
     * the backend only validates "can they be added" and whether values are valid, without a separate assignment scheme.
     * Older callers passing only memberIds keep the rule "in group chats the creator is the lead".
     */
    public record CreateCommand(String conversationId, String type, String name,
                                List<String> memberIds, List<MemberSpec> members,
                                String workspaceId, Boolean autoTitle, String seedKey, String extra) {
    }

    /** null means unchanged. When touch is false, the conversation's order in the list is unchanged (operations like pause don't count as new activity) */
    public record UpdateCommand(String name, String owner, String workspaceId, String status,
                                Boolean paused, Boolean autoTitle, String extra, boolean touch) {
    }

    @Transactional
    public ConversationEntity create(String creatorUserId, CreateCommand command) {
        if (command.conversationId() != null) {
            if (!CLIENT_ID.matcher(command.conversationId()).matches()) {
                throw new BizException(ConversationError.BAD_ID);
            }
            ConversationEntity existing = conversationMapper.findByConversationId(command.conversationId());
            if (existing != null) {
                if (!creatorUserId.equals(existing.getCreator())) {
                    throw new BizException(ConversationError.CONVERSATION_ID_CONFLICT);
                }
                return existing;
            }
        }
        // Direct chats need a name too: a conversation is one task, and "chat with Ama" is not a task
        if (command.name() == null || command.name().isBlank()) {
            throw new BizException(ConversationError.NEEDS_NAME);
        }

        Map<String, String> roles = new LinkedHashMap<>();
        roles.put(creatorUserId, null);
        boolean explicitRoles = command.members() != null;
        if (explicitRoles) {
            for (MemberSpec spec : command.members()) {
                String userId = spec == null ? null : spec.userId();
                roles.put(userId, spec == null || spec.role() == null ? null : normalizeRole(spec.role()));
            }
        }
        if (command.memberIds() != null) {
            for (String memberId : command.memberIds()) {
                roles.putIfAbsent(memberId, null);
            }
        }
        List<UserEntity> joining = new ArrayList<>();
        for (String memberId : roles.keySet()) {
            joining.add(requireCanJoin(creatorUserId, memberId));
        }
        String type = resolveType(command.type(), roles.size());
        if (ConversationEntity.TYPE_GROUP.equals(type)) {
            includeAgentOwners(joining);
            for (UserEntity user : joining) roles.putIfAbsent(user.getUserId(), null);
        }
        requireAgentsPrivate(joining);

        ConversationEntity conversation = newConversation(
                command.conversationId() == null ? idGenerator.conversationId() : command.conversationId(),
                creatorUserId, type, command.name().trim());
        conversation.setWorkspaceId(workspaceService.resolveForConversation(creatorUserId, command.workspaceId()).getWorkspaceId());
        conversation.setAutoTitle(Boolean.TRUE.equals(command.autoTitle()));
        conversation.setSeedKey(command.seedKey() == null || command.seedKey().isBlank() ? null : command.seedKey());
        conversation.setExtra(command.extra());
        conversationMapper.insert(conversation);

        boolean group = ConversationEntity.TYPE_GROUP.equals(type);
        for (Map.Entry<String, String> entry : roles.entrySet()) {
            String role = entry.getValue();
            if (role == null) {
                role = !explicitRoles && group && entry.getKey().equals(creatorUserId)
                        ? ConversationUserRelEntity.ROLE_LEADER
                        : ConversationUserRelEntity.ROLE_ENGINEER;
            }
            addMemberRow(conversation.getConversationId(), entry.getKey(), role);
        }
        return conversation;
    }

    /**
     * Whether this person can be added to a conversation: yourself, a friend, or **an agent you own (on any computer)**.
     * Your own agents don't need to be friends first — that relationship is for humans.
     * Other people's Agents must be explicitly shared by their owner; whether all humans share access is checked in the group-wide validation.
     */
    private UserEntity requireCanJoin(String actorUserId, String memberId) {
        if (memberId == null || memberId.isBlank()) {
            throw new BizException(ConversationError.MEMBER_NOT_IN, "Member must not be empty");
        }
        UserEntity user = userMapper.findByUserId(memberId);
        if (user == null) {
            throw new BizException(ConversationError.MEMBER_NOT_IN, "Member not found: " + memberId);
        }
        if (memberId.equals(actorUserId)) {
            return user;
        }
        if (Boolean.TRUE.equals(user.getIsAgent())) {
            if (actorUserId.equals(user.getOwner()) || relationService.canUseAgent(actorUserId, user)) {
                return user;
            }
            throw new BizException(ConversationError.NOT_FRIEND, "Not yet permitted to use Agent: " + memberId);
        }
        if (!relationService.isFriend(actorUserId, memberId)) {
            throw new BizException(ConversationError.NOT_FRIEND, "Not a friend yet: " + memberId);
        }
        return user;
    }

    /** Every human must hold valid use rights to every Agent in the conversation. */
    private void requireAgentsPrivate(List<UserEntity> members) {
        for (UserEntity agent : members) {
            if (!Boolean.TRUE.equals(agent.getIsAgent())) continue;
            for (UserEntity human : members) {
                if (!Boolean.TRUE.equals(human.getIsAgent()) && !human.getUserId().equals(agent.getOwner()) && !relationService.canUseAgent(human.getUserId(), agent)) {
                    throw new BizException(ConversationError.AGENT_PRIVATE);
                }
            }
        }
    }

    /** Group membership includes every Agent owner, even when the caller omitted them. */
    private void includeAgentOwners(List<UserEntity> members) {
        for (UserEntity agent : List.copyOf(members)) {
            if (!Boolean.TRUE.equals(agent.getIsAgent()) || agent.getOwner() == null) continue;
            if (members.stream().anyMatch(user -> agent.getOwner().equals(user.getUserId()))) continue;
            UserEntity owner = userMapper.findByUserId(agent.getOwner());
            if (owner == null || Boolean.TRUE.equals(owner.getIsAgent())) throw new BizException(ConversationError.MEMBER_NOT_IN);
            members.add(owner);
        }
    }

    /** Type only describes the member count: when unspecified, two people is a direct chat, more is a group chat */
    private static String resolveType(String requested, int memberCount) {
        if (memberCount < 2) {
            throw new BizException(ConversationError.NEEDS_MEMBER);
        }
        if (requested == null || requested.isBlank()) {
            return memberCount == 2 ? ConversationEntity.TYPE_DIRECT : ConversationEntity.TYPE_GROUP;
        }
        String normalized = requested.toUpperCase(Locale.ROOT);
        if (!ConversationEntity.TYPE_DIRECT.equals(normalized) && !ConversationEntity.TYPE_GROUP.equals(normalized)) {
            throw new BizException(ConversationError.BAD_TYPE);
        }
        if (ConversationEntity.TYPE_DIRECT.equals(normalized) && memberCount != 2) {
            throw new BizException(ConversationError.DIRECT_NEEDS_TWO);
        }
        return normalized;
    }

    private ConversationEntity newConversation(String conversationId, String creator, String type, String name) {
        ConversationEntity conversation = new ConversationEntity();
        conversation.setConversationId(conversationId);
        conversation.setName(name);
        conversation.setCreator(creator);
        conversation.setOwner(creator);
        conversation.setType(type);
        conversation.setLastSeq(0L);
        conversation.setState(ConversationEntity.STATE_IDLE);
        conversation.setRoundBudget(8);
        conversation.setStatus(ConversationEntity.STATUS_ACTIVE);
        conversation.setPaused(false);
        conversation.setIsDeleted(false);
        return conversation;
    }

    private void addMemberRow(String conversationId, String userId, String role) {
        ConversationUserRelEntity rel = new ConversationUserRelEntity();
        rel.setConversationId(conversationId);
        rel.setUserId(userId);
        rel.setRole(role);
        memberMapper.upsert(rel);
    }

    private static String normalizeRole(String role) {
        String normalized = role.toUpperCase(Locale.ROOT);
        if (!ROLES.contains(normalized)) {
            throw new BizException(ConversationError.BAD_ROLE);
        }
        return normalized;
    }

    public List<ConversationEntity> list(String userId, int limit) {
        return conversationMapper.listByMember(userId, Math.min(Math.max(limit, 1), MAX_LIST));
    }

    public List<ConversationMapper.SyncCursor> syncCursors(String userId, long afterId, int limit) {
        return conversationMapper.syncCursors(userId, Math.max(0, afterId), Math.min(Math.max(limit, 1), MAX_LIST));
    }

    /** A deleted conversation simply doesn't exist to the outside */
    public ConversationEntity require(String conversationId) {
        ConversationEntity conversation = conversationMapper.findByConversationId(conversationId);
        if (conversation == null || Boolean.TRUE.equals(conversation.getIsDeleted())) {
            throw new BizException(ConversationError.CONVERSATION_NOT_FOUND);
        }
        return conversation;
    }

    public ConversationEntity requireMember(String conversationId, String userId) {
        ConversationEntity conversation = require(conversationId);
        if (memberMapper.findMember(conversationId, userId) == null) {
            throw new BizException(ConversationError.NOT_A_MEMBER);
        }
        return conversation;
    }

    /** Execution terminals can read/update the context of their own member Agent without adding its owner as a human member. */
    private ConversationEntity requireExecutionAccessible(String conversationId, String userId) {
        ConversationEntity conversation = require(conversationId);
        if (memberMapper.findMember(conversationId, userId) != null) return conversation;
        var principal = AuthContext.peek();
        if (principal != null && principal.isNode() && userId.equals(principal.userId()) && principal.terminalId() != null) {
            for (UserEntity agent : memberUsers(conversationId)) {
                if (Boolean.TRUE.equals(agent.getIsAgent()) && userId.equals(agent.getOwner())
                        && principal.terminalId().equals(agent.getTerminalId())) return conversation;
            }
        }
        throw new BizException(ConversationError.NOT_A_MEMBER);
    }

    /** Viewing is account-wide; it never grants membership or human write permission. */
    public ConversationEntity requireAccessible(String conversationId, String userId) {
        ConversationEntity conversation = require(conversationId);
        if (memberMapper.findMember(conversationId, userId) != null || isSharedView(conversationId, userId)) return conversation;
        throw new BizException(ConversationError.NOT_A_MEMBER);
    }

    public boolean isSharedView(String conversationId, String userId) {
        return memberMapper.findMember(conversationId, userId) == null && memberUsers(conversationId).stream()
                .anyMatch(agent -> Boolean.TRUE.equals(agent.getIsAgent()) && userId.equals(agent.getOwner()));
    }

    /** When the owner pauses a shared Agent, other humans can no longer drive this conversation; the Agent's wrap-up replies and the owner are unaffected */
    public void requireNotOwnerPaused(String conversationId, String actorId) {
        for (ConversationUserRelEntity member : memberMapper.listMembers(conversationId)) {
            if (!Boolean.TRUE.equals(member.getOwnerPaused())) continue;
            UserEntity actor = userMapper.findByUserId(actorId);
            if (actor != null && Boolean.TRUE.equals(actor.getIsAgent())) return;
            UserEntity agent = userMapper.findByUserId(member.getUserId());
            if (agent != null && !actorId.equals(agent.getOwner())) {
                throw new BizException(ConversationError.OWNER_PAUSED);
            }
        }
    }

    /** Agent owners can pause their shared work from any signed-in terminal. */
    @Transactional
    public void setOwnerPaused(String conversationId, String ownerId, boolean paused) {
        requireAccessible(conversationId, ownerId);
        boolean owns = memberUsers(conversationId).stream()
                .anyMatch(user -> Boolean.TRUE.equals(user.getIsAgent()) && ownerId.equals(user.getOwner()));
        if (!owns) throw new BizException(ConversationError.NOT_A_MEMBER);
        memberMapper.setOwnerPaused(conversationId, ownerId, paused);
        notifyConversationUpdated(conversationId);
    }

    public void requireAgentAccess(String humanId, UserEntity agent) {
        if (!humanId.equals(agent.getOwner()) && !relationService.canUseAgent(humanId, agent)) {
            throw new BizException(ConversationError.AGENT_PRIVATE);
        }
    }

    /**
     * Direct chats between humans can't continue after unfriending: the history stays, but it's no longer a relationship that can talk.
     * Agent conversations and group chats are unaffected.
     */
    public void requireCanSpeak(ConversationEntity conversation, String senderId) {
        requireAgentsPrivate(memberUsers(conversation.getConversationId()));
        requireNotOwnerPaused(conversation.getConversationId(), senderId);
        if (!ConversationEntity.TYPE_DIRECT.equals(conversation.getType())) {
            return;
        }
        List<UserEntity> users = memberUsers(conversation.getConversationId());
        for (UserEntity user : users) {
            if (Boolean.TRUE.equals(user.getIsAgent())) {
                return;
            }
        }
        for (UserEntity user : users) {
            if (!user.getUserId().equals(senderId) && !relationService.isFriend(senderId, user.getUserId())) {
                throw new BizException(MessageError.NOT_FRIEND);
            }
        }
    }

    /**
     * A message from a human to other humans: the sender is human and the conversation has other humans.
     * A conversation with only yourself and your own Agents is assigning work to Agents and doesn't count (an Agent never shares a conversation with someone else's Agent).
     */
    public boolean isSpeakingToPeople(String conversationId, String senderId) {
        List<UserEntity> users = memberUsers(conversationId);
        boolean senderIsPerson = users.stream()
                .anyMatch(user -> user.getUserId().equals(senderId) && !Boolean.TRUE.equals(user.getIsAgent()));
        return senderIsPerson && users.stream()
                .anyMatch(user -> !user.getUserId().equals(senderId) && !Boolean.TRUE.equals(user.getIsAgent()));
    }

    public List<ConversationUserRelEntity> members(String conversationId) {
        return memberMapper.listMembers(conversationId);
    }

    public List<String> memberIds(String conversationId) {
        return memberMapper.listMemberIds(conversationId);
    }

    public List<UserEntity> memberUsers(String conversationId) {
        List<String> ids = memberMapper.listMemberIds(conversationId);
        return ids.isEmpty() ? List.of() : userMapper.findByUserIds(ids);
    }

    public int unreadCount(String conversationId, String userId) {
        return memberMapper.countUnread(conversationId, userId);
    }

    @Transactional
    public ConversationEntity updateMutable(String conversationId, String actorUserId, UpdateCommand command) {
        ConversationEntity current = requireExecutionAccessible(conversationId, actorUserId);
        ConversationEntity patch = new ConversationEntity();
        patch.setConversationId(conversationId);
        if (command.name() != null) {
            if (command.name().isBlank()) {
                throw new BizException(ConversationError.NEEDS_NAME);
            }
            patch.setName(command.name().trim());
        }
        if (command.owner() != null) {
            if (memberMapper.findMember(conversationId, command.owner()) == null) {
                throw new BizException(ConversationError.MEMBER_NOT_IN);
            }
            // Owner means "whose matter this is", which is different from Leader (which agent leads); member roles are not touched here
            patch.setOwner(command.owner());
        }
        // The workspace belongs to the creator; people added can't move it into their own workspace (on their side it is already under "No workspace")
        if (command.workspaceId() != null && actorUserId.equals(current.getCreator())) {
            patch.setWorkspaceId(workspaceService.requireOwned(actorUserId, command.workspaceId()).getWorkspaceId());
        }
        if (command.status() != null) {
            String status = command.status().toUpperCase(Locale.ROOT);
            if (!STATUSES.contains(status)) {
                throw new BizException(ConversationError.BAD_STATUS);
            }
            patch.setStatus(status);
        }
        patch.setPaused(command.paused());
        patch.setAutoTitle(command.autoTitle());
        patch.setExtra(command.extra());
        conversationMapper.updateMutable(patch);
        if (command.touch()) {
            conversationMapper.touch(conversationId);
        }
        notifyConversationUpdated(conversationId);
        return require(conversationId);
    }

    /** Soft delete. Deleting twice gives the same result: a second delete during offline replay doesn't error */
    @Transactional
    public void delete(String conversationId, String actorUserId) {
        ConversationEntity conversation = conversationMapper.findByConversationId(conversationId);
        if (conversation == null || Boolean.TRUE.equals(conversation.getIsDeleted())) {
            return;
        }
        if (memberMapper.findMember(conversationId, actorUserId) == null) {
            throw new BizException(ConversationError.NOT_A_MEMBER);
        }
        if (!actorUserId.equals(conversation.getOwner()) && !actorUserId.equals(conversation.getCreator())) {
            throw new BizException(ConversationError.NOT_OWNER);
        }
        List<String> members = memberMapper.listViewerIds(conversationId);
        conversationMapper.softDelete(conversationId);
        nodeRegistry.broadcast(members, NodeFrame.of(FrameType.CONVERSATION_UPDATED, Map.of("conversationId", conversationId)));
    }

    @Transactional
    public void addMember(String conversationId, String actorUserId, String memberId, String role) {
        conversationMapper.lockMembers(conversationId);
        ConversationEntity conversation = requireMember(conversationId, actorUserId);
        if (ConversationEntity.TYPE_DIRECT.equals(conversation.getType())) {
            throw new BizException(ConversationError.BAD_TYPE, "Cannot add people to a direct chat");
        }
        UserEntity joining = requireCanJoin(actorUserId, memberId);
        List<UserEntity> after = new ArrayList<>(memberUsers(conversationId));
        after.add(joining);
        includeAgentOwners(after);
        requireAgentsPrivate(after);
        String normalizedRole = role == null ? ConversationUserRelEntity.ROLE_ENGINEER : normalizeRole(role);
        if (memberMapper.findMember(conversationId, memberId) != null) {
            throw new BizException(ConversationError.MEMBER_ALREADY_IN);
        }
        addMemberRow(conversationId, memberId, normalizedRole);
        for (UserEntity user : after) {
            if (!user.getUserId().equals(memberId) && memberMapper.findMember(conversationId, user.getUserId()) == null)
                addMemberRow(conversationId, user.getUserId(), ConversationUserRelEntity.ROLE_ENGINEER);
        }
        conversationMapper.touch(conversationId);
        notifyConversationUpdated(conversationId);
    }

    /**
     * Change a member's role, pause them in this conversation only, and whether they auto-resume when the conversation continues.
     * Follow-on adjustments such as Leader handover are computed by the shared desktop scheduling rules and submitted member by member.
     */
    @Transactional
    public void updateMember(String conversationId, String actorUserId, String memberId,
                             String role, Boolean paused, Boolean resumeOnContinue) {
        ConversationEntity conversation = requireExecutionAccessible(conversationId, actorUserId);
        if (memberMapper.findMember(conversationId, memberId) == null) {
            throw new BizException(ConversationError.MEMBER_NOT_IN);
        }
        ConversationUserRelEntity patch = new ConversationUserRelEntity();
        patch.setConversationId(conversationId);
        patch.setUserId(memberId);
        if (role != null) {
            if (ConversationEntity.TYPE_DIRECT.equals(conversation.getType())) {
                throw new BizException(ConversationError.BAD_TYPE, "Direct chats don't have member roles");
            }
            patch.setRole(normalizeRole(role));
        }
        patch.setPaused(paused);
        patch.setResumeOnContinue(resumeOnContinue);
        memberMapper.updateMember(patch);
        if (role != null) {
            conversationMapper.touch(conversationId);
        }
        notifyConversationUpdated(conversationId);
    }

    @Transactional
    public void removeMember(String conversationId, String actorUserId, String memberId) {
        conversationMapper.lockMembers(conversationId);
        ConversationEntity conversation = requireMember(conversationId, actorUserId);
        if (ConversationEntity.TYPE_DIRECT.equals(conversation.getType())) {
            throw new BizException(ConversationError.BAD_TYPE, "Cannot remove people from a direct chat");
        }
        if (conversation.getOwner().equals(memberId)) {
            throw new BizException(ConversationError.CANNOT_REMOVE_OWNER);
        }
        if (memberMapper.findMember(conversationId, memberId) == null) {
            throw new BizException(ConversationError.MEMBER_NOT_IN);
        }
        if (memberUsers(conversationId).stream().anyMatch(user -> Boolean.TRUE.equals(user.getIsAgent()) && memberId.equals(user.getOwner()))) {
            throw new BizException(ConversationError.CANNOT_REMOVE_AGENT_OWNER);
        }
        memberMapper.removeMember(conversationId, memberId);
        conversationMapper.touch(conversationId);
        notifyConversationUpdated(conversationId);
    }

    public List<String> viewerIds(String conversationId) {
        return memberMapper.listViewerIds(conversationId);
    }

    public void notifyConversationUpdated(String conversationId) {
        nodeRegistry.broadcast(memberMapper.listViewerIds(conversationId),
                NodeFrame.of(FrameType.CONVERSATION_UPDATED,
                        Map.of("conversationId", conversationId)));
    }
}
