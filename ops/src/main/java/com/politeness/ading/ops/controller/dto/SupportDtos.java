package com.politeness.ading.ops.controller.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.time.LocalDateTime;
import java.util.List;

/** Inputs and views for issue reports and user contacts. Body text is stored only in the database; attachment bodies are in OSS, only object keys are recorded here. */
public final class SupportDtos {

    private SupportDtos() {
    }

    public record AttachmentIngest(
            @NotBlank @Size(max = 32) String kind,
            @NotBlank @Size(max = 200) String name,
            @NotBlank @Size(max = 512) String objectKey,
            @Size(max = 100) String contentType,
            long sizeBytes) {
    }

    public record FeedbackIngest(
            @NotBlank @Size(max = 100) String reportId,
            @Size(max = 64) String userId,
            @Size(max = 128) String terminalId,
            @NotBlank @Size(max = 64) String occurredAt,
            @NotBlank @Size(max = 64) String createdAt,
            @NotBlank @Size(max = 4000) String description,
            @NotBlank @Size(max = 50) String appVersion,
            @NotBlank @Size(max = 30) String platform,
            @NotBlank @Size(max = 30) String arch,
            @NotBlank @Size(max = 30) String mode,
            @NotBlank @Size(max = 255) String objectPrefix,
            @Size(max = 16) List<@Valid AttachmentIngest> attachments) {
    }

    public record ContactIngest(
            @NotBlank @Size(max = 100) String contactId,
            @Size(max = 64) String userId,
            @Size(max = 128) String terminalId,
            @NotBlank @Size(max = 64) String createdAt,
            @NotBlank @Size(max = 120) String subject,
            @NotBlank @Size(max = 4000) String content,
            @Size(max = 200) String replyTo,
            @NotBlank @Size(max = 50) String appVersion,
            @NotBlank @Size(max = 30) String platform,
            @NotBlank @Size(max = 30) String arch,
            @NotBlank @Size(max = 30) String mode,
            @Size(max = 16) List<@Valid AttachmentIngest> attachments) {
    }

    /** status: created = newly stored this time; duplicate = the same id already exists, not written again. */
    public record IngestResult(String id, String status) {
    }

    public record StatusChange(@NotBlank @Size(max = 16) String status) {
    }

    public record AttachmentView(long id, String kind, String name, String contentType, long sizeBytes) {
    }

    public record FeedbackView(
            String reportId,
            String userId,
            String terminalId,
            String status,
            String description,
            LocalDateTime occurredAt,
            LocalDateTime submittedAt,
            String appVersion,
            String channel,
            String platform,
            String arch,
            String mode,
            String objectPrefix,
            String handledBy,
            LocalDateTime statusChangedAt,
            List<AttachmentView> attachments) {
    }

    public record ContactView(
            String contactId,
            String userId,
            String terminalId,
            String subject,
            String content,
            String replyTo,
            LocalDateTime submittedAt,
            String appVersion,
            String channel,
            String platform,
            String arch,
            String mode,
            List<AttachmentView> attachments) {
    }

    /** counts are the totals per status; the page shows them on the filter buttons. */
    public record FeedbackPage(PageView<FeedbackView> feedback, java.util.Map<String, Long> counts) {
    }
}
