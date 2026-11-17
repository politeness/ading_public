package com.politeness.ading.conductor.controller.dto;

import com.politeness.ading.conductor.dal.entity.UserEntity;

public record UserView(
        String userId,
        String username,
        String displayName,
        boolean isAgent,
        String status,
        String agentType,
        String agentVersion,
        String permissionLevel,
        String persona,
        String owner,
        /** Name of the agent's computer; filled only for agents in the friend list, null elsewhere */
        String computerName,
        /** Whether the agent's computer is currently connected to the server; the mobile app cannot give it work while that computer is offline */
        Boolean computerOnline,
        /** terminal_id of the agent's computer. Distinguishes same-named agents (e.g. two computers each with an agent of that name) */
        String computerId,
        /**
         * The agent's readiness on its computer (ready / unauthorized / exhausted …), reported by that computer.
         * Other computers use it for the green light: available only when computerOnline and readiness = ready, the same meaning as the local green light.
         */
        String readiness,
        /** A human's avatar (currently a data URL); null for agents */
        String avatarUrl,
        /** The agent's current model, reported by its computer; only sent to the agent's owner. Null for older clients that don't report it */
        AgentModelState model) {

    public static UserView from(UserEntity user) {
        return new UserView(
                user.getUserId(),
                user.getUsername(),
                user.getDisplayName(),
                Boolean.TRUE.equals(user.getIsAgent()),
                user.getStatus(),
                user.getAgentType(),
                user.getAgentVersion(),
                user.getPermissionLevel(),
                user.getPersona(),
                user.getOwner(),
                null,
                null,
                null,
                null,
                Boolean.TRUE.equals(user.getIsAgent()) ? null : user.getAvatarUrl(),
                null);
    }

    public UserView withComputer(String computerId, String name, Boolean online, String readiness) {
        return new UserView(userId, username, displayName, isAgent, status, agentType, agentVersion,
                permissionLevel, persona, owner, name, online, computerId, readiness, avatarUrl, model);
    }

    public UserView withModel(AgentModelState state) {
        return new UserView(userId, username, displayName, isAgent, status, agentType, agentVersion,
                permissionLevel, persona, owner, computerName, computerOnline, computerId, readiness, avatarUrl, state);
    }
}
