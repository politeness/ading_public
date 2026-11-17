package com.politeness.ading.conductor.controller.dto;

import com.politeness.ading.conductor.dal.entity.UserEntity;
import java.time.Instant;

/**
 * Another human seen when adding friends: shared by search results and friend requests.
 * Only the fields needed to recognize someone; email and phone are not exposed, since the searcher already knows what they typed.
 *
 * relation: FRIEND already friends; OUTGOING I sent a request awaiting their approval; INCOMING they sent me a request; NONE no relation yet
 */
public record PersonView(
        String userId,
        String username,
        String displayName,
        String avatarUrl,
        String relation,
        /** Time of the request; null in search results */
        Instant requestedAt) {

    public static final String FRIEND   = "FRIEND";
    public static final String OUTGOING = "OUTGOING";
    public static final String INCOMING = "INCOMING";
    public static final String NONE     = "NONE";

    public static PersonView of(UserEntity user, String relation, Instant requestedAt) {
        return new PersonView(user.getUserId(), user.getUsername(), user.getDisplayName(),
                user.getAvatarUrl(), relation, requestedAt);
    }
}
