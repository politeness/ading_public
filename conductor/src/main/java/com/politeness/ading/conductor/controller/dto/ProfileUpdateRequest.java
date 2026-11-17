package com.politeness.ading.conductor.controller.dto;

/** Omitted fields are left unchanged; an empty string for avatar, phone, or email clears it */
public record ProfileUpdateRequest(String displayName, String avatarUrl, String phone, String email) {
}
