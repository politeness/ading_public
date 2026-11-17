package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.Size;

public record AgentSessionUpsertRequest(
        @Size(max = 128) String providerThreadId,
        @Size(max = 512) String workspacePath) {
}
