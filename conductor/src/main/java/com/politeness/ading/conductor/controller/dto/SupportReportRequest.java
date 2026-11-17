package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Input for a desktop issue report. Fields map one-to-one to the JSON in the pending-upload outbox;
 * extra fields the desktop writes, such as schemaVersion and status, are not used here and Jackson ignores them.
 */
public record SupportReportRequest(
        Integer schemaVersion,
        @NotBlank @Size(max = 100) String reportId,
        @NotBlank String createdAt,
        @NotBlank String occurredAt,
        @NotBlank @Size(max = 4000) String description,
        @Valid ImagePayload screenshot,
        @Size(max = 5) List<@Valid ImagePayload> images,
        @NotNull @Valid Context context) {

    /** Missing collections are treated as empty, so one missing field does not fail the whole report with a 400. */
    public SupportReportRequest {
        images = images == null ? List.of() : List.copyOf(images);
    }

    public record ImagePayload(
            @NotBlank @Size(max = 160) String name,
            @NotBlank @Size(max = 60) String mimeType,
            @NotBlank String dataUrl) {
    }

    public record LogPayload(
            @NotBlank @Size(max = 160) String name,
            @NotNull String content) {
    }

    /**
     * Archive of the full logs (base64 of a tar.gz). The desktop collects and compresses them and hands them to the backend,
     * which uploads them to OSS; OSS credentials live only on the backend and the desktop never sees them.
     */
    public record LogArchivePayload(
            @NotBlank @Size(max = 200) String name,
            @NotBlank String base64,
            Integer fileCount,
            Long rawBytes,
            Long packedBytes) {
    }

    public record Context(
            @NotBlank @Size(max = 50) String appVersion,
            @NotBlank @Size(max = 30) String platform,
            @NotBlank @Size(max = 30) String arch,
            @NotBlank @Size(max = 30) String mode,
            @Size(max = 2) List<@Valid LogPayload> logs,
            @Valid LogArchivePayload logArchive,
            @Size(max = 64) String userId,
            @Size(max = 128) String terminalId) {

        public Context {
            logs = logs == null ? List.of() : List.copyOf(logs);
        }
    }
}
