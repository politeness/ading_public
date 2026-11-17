package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

public record DeveloperContactRequest(
        Integer schemaVersion,
        @NotBlank @Size(max = 100) String contactId,
        @NotBlank String createdAt,
        @NotBlank @Size(max = 120) String subject,
        @NotBlank @Size(max = 4000) String content,
        @Size(max = 200) String replyTo,
        @NotNull @Valid Context context,
        @Size(max = 5) List<@Valid AttachmentPayload> attachments) {

    /** Reply method and attachments may be empty; a missing field does not make the request invalid, since older clients have no attachments field. */
    public DeveloperContactRequest {
        replyTo = replyTo == null ? "" : replyTo;
        attachments = attachments == null ? List.of() : List.copyOf(attachments);
    }

    public record AttachmentPayload(
            @NotBlank @Size(max = 160) String name,
            @Size(max = 100) String mimeType,
            @NotBlank String base64) {
    }

    public record Context(
            @NotBlank @Size(max = 50) String appVersion,
            @NotBlank @Size(max = 30) String platform,
            @NotBlank @Size(max = 30) String arch,
            @NotBlank @Size(max = 30) String mode,
            @Size(max = 64) String userId,
            @Size(max = 128) String terminalId) {
    }
}
