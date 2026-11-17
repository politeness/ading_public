package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;

public record MemberAddRequest(@NotBlank String userId, String role) {
}
