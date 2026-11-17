package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;
import tools.jackson.databind.JsonNode;

/** content may be an empty string (attachments only) but must be present; MessageService decides whether there is content, taking attachments into account */
public record MessageSendRequest(
        @NotBlank @Size(max = 64) String messageId,
        @NotNull @Size(max = 200000) String content,
        String type,
        List<String> mentions,
        String replyTo,
        Boolean internal,
        Boolean report,
        Boolean failed,
        JsonNode extra,
        /** IDs of registered and fully uploaded attachments, in display order */
        List<String> attachments) {
}
