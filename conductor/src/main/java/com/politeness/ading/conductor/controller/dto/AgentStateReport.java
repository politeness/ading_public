package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * A computer publishes the state of its own agents. Like messages, this is "sync": this computer is the authority, the server only stores and forwards,
 * and other computers set the traffic lights themselves using the same rules as the offline edition.
 */
public record AgentStateReport(@NotNull @Size(max = 64) List<@Valid Item> agents) {

    public record Item(
            @NotBlank @Size(max = 64) String userId,
            /** Readiness state, values match the desktop's AgentReadiness */
            @NotBlank @Size(max = 32) String readiness,
            /** The agent version detected on this computer; omitted means unchanged. After an upgrade, this lets other computers see the new version */
            @Size(max = 64) String agentVersion,
            /** The current model of the agent on this computer; old clients omit it, meaning unchanged */
            @Valid AgentModelState model) {
    }
}
