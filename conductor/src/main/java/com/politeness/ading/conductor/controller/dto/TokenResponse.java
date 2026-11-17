package com.politeness.ading.conductor.controller.dto;

public record TokenResponse(String accessToken, String refreshToken, UserView user, boolean canAddFriend, boolean onboardingEligible) {
}
