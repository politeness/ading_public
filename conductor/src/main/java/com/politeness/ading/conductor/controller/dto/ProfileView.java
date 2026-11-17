package com.politeness.ading.conductor.controller.dto;

import com.politeness.ading.conductor.dal.entity.UserEntity;

public record ProfileView(
        String userId,
        String username,
        String displayName,
        String avatarUrl,
        String phone,
        String email) {

    public static ProfileView from(UserEntity user) {
        return new ProfileView(
                user.getUserId(),
                user.getUsername(),
                user.getDisplayName(),
                user.getAvatarUrl(),
                user.getPhone(),
                user.getEmail());
    }
}
