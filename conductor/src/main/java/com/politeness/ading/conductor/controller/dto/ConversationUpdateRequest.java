package com.politeness.ading.conductor.controller.dto;

import tools.jackson.databind.JsonNode;

/**
 * Updates a conversation. Omitted fields are left unchanged.
 * extra is the desktop scheduler's full runtime state; if provided it replaces the stored value entirely.
 * touch defaults to true; pass false for operations that are not new activity (such as pausing) so the conversation keeps its position in the list.
 */
public record ConversationUpdateRequest(
        String name,
        String owner,
        String workspaceId,
        String status,
        Boolean paused,
        Boolean autoTitle,
        JsonNode extra,
        Boolean touch) {
}
