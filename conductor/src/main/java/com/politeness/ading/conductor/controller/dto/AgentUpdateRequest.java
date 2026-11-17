package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.Size;

public record AgentUpdateRequest(
        @Size(max = 30) String displayName,
        @Size(max = 32) String permissionLevel,
        String persona) {
}
