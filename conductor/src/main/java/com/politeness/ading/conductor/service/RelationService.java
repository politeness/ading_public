package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.Times;
import com.politeness.ading.conductor.controller.dto.PersonView;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.entity.UserRelEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.dal.mapper.UserRelMapper;
import com.politeness.ading.conductor.error.FriendError;
import com.politeness.ading.conductor.manager.FrameType;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Friend relationships. Both kinds of friends use the same users_rel table:
 * - agents you own: adding as a contact makes them a friend directly, no request needed;
 * - humans: one side requests first (a single PENDING row, direction requester → target), and after acceptance it becomes two ACCEPTED rows, one per direction.
 *
 * SHARED is a one-way Agent use right granted by the owner to a human friend, separate from the ACCEPTED friend relationship.
 */
@Service
public class RelationService {

    private final UserRelMapper userRelMapper;
    private final UserMapper userMapper;
    private final NodeRegistry nodeRegistry;

    public RelationService(UserRelMapper userRelMapper, UserMapper userMapper, NodeRegistry nodeRegistry) {
        this.userRelMapper = userRelMapper;
        this.userMapper = userMapper;
        this.nodeRegistry = nodeRegistry;
    }

    /**
     * Create a two-way friend relationship, writing two rows.
     * Both adding your own agent as a contact and a human accepting a request end up here.
     */
    @Transactional
    public void befriend(String userId, String friendId) {
        if (userId.equals(friendId)) {
            return;
        }
        upsert(userId, friendId);
        upsert(friendId, userId);
    }

    private void upsert(String userId, String friendId) {
        UserRelEntity rel = new UserRelEntity();
        rel.setUserId(userId);
        rel.setFriendId(friendId);
        rel.setStatus(UserRelEntity.STATUS_ACCEPTED);
        userRelMapper.upsert(rel);
    }

    /** Remove the friend relationship in both directions, along with unhandled requests either way. Deleting twice gives the same result */
    @Transactional
    public void unfriend(String userId, String friendId) {
        userRelMapper.deletePair(userId, friendId);
        userRelMapper.revokeSharesBetween(userId, friendId);
    }

    public boolean canUseAgent(String humanId, UserEntity agent) {
        if (humanId.equals(agent.getOwner())) return true;
        UserRelEntity grant = userRelMapper.find(humanId, agent.getUserId());
        return grant != null && "SHARED".equals(grant.getStatus()) && isFriend(humanId, agent.getOwner());
    }

    @Transactional
    public void shareAgent(String owner, String agentId, String recipient, boolean share) {
        UserEntity agent = userMapper.findByUserId(agentId);
        UserEntity person = userMapper.findByUserId(recipient);
        if (agent == null || !Boolean.TRUE.equals(agent.getIsAgent()) || !owner.equals(agent.getOwner())
                || person == null || Boolean.TRUE.equals(person.getIsAgent()) || owner.equals(recipient)) {
            throw new BizException(FriendError.UNAVAILABLE);
        }
        if (share) {
            if (!isFriend(owner, recipient)) throw new BizException(FriendError.UNAVAILABLE);
            UserRelEntity grant = new UserRelEntity();
            grant.setUserId(recipient);
            grant.setFriendId(agentId);
            grant.setStatus("SHARED");
            userRelMapper.upsert(grant);
        } else {
            userRelMapper.revokeAgent(recipient, agentId);
        }
        // Every grantee caches the full recipient list to check whether an Agent can join a group.
        // Refresh existing grantees too, and include the removed recipient so revoked access disappears.
        var audience = new LinkedHashSet<>(userRelMapper.listAgentRecipients(agentId));
        audience.add(owner);
        audience.add(recipient);
        nodeRegistry.broadcast(audience, NodeFrame.of(FrameType.FRIENDS_CHANGED, Map.of()));
    }

    public Map<String, List<String>> agentShares(String actor) {
        Map<String, List<String>> shares = new HashMap<>();
        List<String> sharedIds = userRelMapper.listSharedAgentIds(actor);
        List<UserEntity> agents = new ArrayList<>(sharedIds.isEmpty() ? List.of() : userMapper.findByUserIds(sharedIds));
        agents.addAll(userMapper.findAgentsByOwner(actor));
        for (UserEntity agent : agents) {
            if (Boolean.TRUE.equals(agent.getIsAgent()) && canUseAgent(actor, agent)) {
                shares.put(agent.getUserId(), userRelMapper.listAgentRecipients(agent.getUserId()).stream()
                        .filter(id -> isFriend(id, agent.getOwner())).toList());
            }
        }
        return shares;
    }

    public List<UserEntity> listFriends(String userId) {
        List<String> ids = new ArrayList<>(userRelMapper.listFriendIds(userId));
        ids.addAll(userRelMapper.listSharedAgentIds(userId));
        if (ids.isEmpty()) return List.of();
        return userMapper.findByUserIds(ids).stream()
                .filter(user -> !Boolean.TRUE.equals(user.getIsAgent()) || canUseAgent(userId, user)).toList();
    }

    public boolean isFriend(String userId, String otherId) {
        return userId.equals(otherId) || userRelMapper.countAccepted(userId, otherId) > 0;
    }

    // ------------------------------------------------------------------
    // Between humans: search, request, accept, decline
    // ------------------------------------------------------------------

    /** Find people by exact username, email or phone number, with their relationship to me; returns an empty list if not found */
    public List<PersonView> search(String actorUserId, String query) {
        String key = query == null ? "" : query.trim();
        if (key.isEmpty()) {
            throw new BizException(FriendError.QUERY_BLANK);
        }
        List<PersonView> result = new ArrayList<>();
        for (UserEntity user : userMapper.findHumansByExactKey(key)) {
            if (user.getUserId().equals(actorUserId)) continue;
            result.add(PersonView.of(user, relationOf(actorUserId, user.getUserId()), null));
        }
        return result;
    }

    private String relationOf(String actorUserId, String otherId) {
        UserRelEntity mine = userRelMapper.find(actorUserId, otherId);
        if (mine != null && UserRelEntity.STATUS_ACCEPTED.equals(mine.getStatus())) return PersonView.FRIEND;
        if (mine != null && UserRelEntity.STATUS_PENDING.equals(mine.getStatus())) return PersonView.OUTGOING;
        UserRelEntity theirs = userRelMapper.find(otherId, actorUserId);
        if (theirs != null && UserRelEntity.STATUS_PENDING.equals(theirs.getStatus())) return PersonView.INCOMING;
        return PersonView.NONE;
    }

    /**
     * Request to add the other person as a friend. Does nothing if already friends; if they already requested me, we become friends directly.
     * Repeated requests give the same result. Returns the relationship after the request (OUTGOING or FRIEND)
     */
    @Transactional
    public String request(String actorUserId, String targetId) {
        if (actorUserId.equals(targetId)) {
            throw new BizException(FriendError.SELF);
        }
        UserEntity target = userMapper.findByUserId(targetId);
        if (target == null) {
            throw new BizException(FriendError.USER_NOT_FOUND);
        }
        if (Boolean.TRUE.equals(target.getIsAgent())) {
            throw new BizException(FriendError.NOT_A_PERSON);
        }
        // I blocked them: unblock first; they blocked me: don't reveal the block, just say it can't be added
        if (isBlocked(actorUserId, targetId)) {
            throw new BizException(FriendError.BLOCKED_BY_ME);
        }
        if (isBlocked(targetId, actorUserId)) {
            throw new BizException(FriendError.UNAVAILABLE);
        }
        String relation = relationOf(actorUserId, targetId);
        if (PersonView.FRIEND.equals(relation)) {
            return relation;
        }
        if (PersonView.INCOMING.equals(relation)) {
            befriend(actorUserId, targetId);
            notifyBoth(actorUserId, targetId);
            return PersonView.FRIEND;
        }
        UserRelEntity rel = new UserRelEntity();
        rel.setUserId(actorUserId);
        rel.setFriendId(targetId);
        rel.setStatus(UserRelEntity.STATUS_PENDING);
        userRelMapper.upsert(rel);
        notifyBoth(actorUserId, targetId);
        return PersonView.OUTGOING;
    }

    /** Accept a request they sent me */
    @Transactional
    public void accept(String actorUserId, String requesterId) {
        UserRelEntity pending = userRelMapper.find(requesterId, actorUserId);
        if (pending == null || !UserRelEntity.STATUS_PENDING.equals(pending.getStatus())) {
            // Accepting again when already friends gives the same result
            if (isFriend(actorUserId, requesterId)) return;
            throw new BizException(FriendError.REQUEST_NOT_FOUND);
        }
        befriend(actorUserId, requesterId);
        notifyBoth(actorUserId, requesterId);
    }

    /** Decline their request, or withdraw one I sent. Does nothing if none exists */
    @Transactional
    public void dismissRequest(String actorUserId, String otherId) {
        int removed = userRelMapper.deletePending(otherId, actorUserId)
                + userRelMapper.deletePending(actorUserId, otherId);
        if (removed > 0) notifyBoth(actorUserId, otherId);
    }

    /** Pending requests, both received and sent */
    public List<PersonView> listRequests(String actorUserId) {
        List<UserRelEntity> incoming = userRelMapper.listIncoming(actorUserId);
        List<UserRelEntity> outgoing = userRelMapper.listOutgoing(actorUserId);
        List<String> ids = new ArrayList<>();
        incoming.forEach(rel -> ids.add(rel.getUserId()));
        outgoing.forEach(rel -> ids.add(rel.getFriendId()));
        if (ids.isEmpty()) {
            return List.of();
        }
        Map<String, UserEntity> users = userMapper.findByUserIds(ids).stream()
                .collect(Collectors.toMap(UserEntity::getUserId, Function.identity(), (a, b) -> a, HashMap::new));
        List<PersonView> result = new ArrayList<>();
        for (UserRelEntity rel : incoming) {
            UserEntity user = users.get(rel.getUserId());
            if (user != null) result.add(PersonView.of(user, PersonView.INCOMING, Times.instant(rel.getGmtCreated())));
        }
        for (UserRelEntity rel : outgoing) {
            UserEntity user = users.get(rel.getFriendId());
            if (user != null) result.add(PersonView.of(user, PersonView.OUTGOING, Times.instant(rel.getGmtCreated())));
        }
        return result;
    }

    // ------------------------------------------------------------------
    // Blocking: humans only. After blocking, the two are no longer friends (human direct chats require friendship to send, so messages stop too),
    // and they can't request to add me again. Only one BLOCKED row "me → them" is written, and they can't see they've been blocked
    // ------------------------------------------------------------------

    @Transactional
    public void block(String actorUserId, String targetId) {
        if (actorUserId.equals(targetId)) {
            throw new BizException(FriendError.SELF);
        }
        UserEntity target = userMapper.findByUserId(targetId);
        if (target == null) {
            throw new BizException(FriendError.USER_NOT_FOUND);
        }
        if (Boolean.TRUE.equals(target.getIsAgent())) {
            throw new BizException(FriendError.NOT_A_PERSON);
        }
        userRelMapper.deletePair(actorUserId, targetId);
        userRelMapper.revokeSharesBetween(actorUserId, targetId);
        UserRelEntity rel = new UserRelEntity();
        rel.setUserId(actorUserId);
        rel.setFriendId(targetId);
        rel.setStatus(UserRelEntity.STATUS_BLOCKED);
        userRelMapper.upsert(rel);
        notifyBoth(actorUserId, targetId);
    }

    /** Unblock. Doesn't restore the friendship; you have to add again */
    @Transactional
    public void unblock(String actorUserId, String targetId) {
        if (userRelMapper.deleteBlocked(actorUserId, targetId) > 0) {
            notifyBoth(actorUserId, targetId);
        }
    }

    public List<UserEntity> listBlocked(String actorUserId) {
        List<String> ids = userRelMapper.listBlockedIds(actorUserId);
        if (ids.isEmpty()) {
            return List.of();
        }
        Map<String, UserEntity> users = userMapper.findByUserIds(ids).stream()
                .collect(Collectors.toMap(UserEntity::getUserId, Function.identity(), (a, b) -> a, HashMap::new));
        return ids.stream().map(users::get).filter(Objects::nonNull).toList();
    }

    private boolean isBlocked(String userId, String otherId) {
        UserRelEntity rel = userRelMapper.find(userId, otherId);
        return rel != null && UserRelEntity.STATUS_BLOCKED.equals(rel.getStatus());
    }

    /** Friends or requests changed: all online computers of both people re-fetch */
    public void notifyBoth(String userId, String otherId) {
        nodeRegistry.broadcast(List.of(userId, otherId), NodeFrame.of(FrameType.FRIENDS_CHANGED, Map.of()));
    }
}
