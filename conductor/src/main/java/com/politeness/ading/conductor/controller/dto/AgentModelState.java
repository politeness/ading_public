package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.Size;

/** The current model reported by the computer hosting the Agent; the server only stores and forwards it. The model list must be asked from that computer on demand and is not stored in the cloud. */
public record AgentModelState(
        /** The model chosen in ADing; empty means follow the original app */
        @Size(max = 200) String selected,
        @Size(max = 200) String selectedLabel,
        /** The original app's current model */
        @Size(max = 200) String nativeModel) {
}
