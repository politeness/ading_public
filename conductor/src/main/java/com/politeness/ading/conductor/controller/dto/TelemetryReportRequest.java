package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * Device telemetry reported while the desktop window is in the foreground, at most once per hour.
 * user_id is not here: it comes from the request's token; clients cannot self-report it.
 */
public record TelemetryReportRequest(
        @NotBlank @Pattern(regexp = "[0-9a-fA-F]{64}", message = "Invalid device ID format") String deviceUuid,
        @NotBlank @Size(max = 16) String deviceType,
        @Size(max = 30) String phone,
        @Size(max = 254) String email,
        @Size(max = 20) List<@Size(max = 32) String> agents,
        @Size(max = 50) String appVersion,
        @Size(max = 64) String osVersion) {
    public TelemetryReportRequest(String deviceUuid, String deviceType, String phone, String email, List<String> agents) {
        this(deviceUuid, deviceType, phone, email, agents, null, null);
    }
}
