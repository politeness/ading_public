package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record AgentRegisterRequest(
        @NotBlank @Size(max = 64) String localUuid,
        @NotBlank @Size(max = 32) String agentType,
        @Size(max = 64) String agentVersion,
        @Size(max = 30) String displayName) {
}
