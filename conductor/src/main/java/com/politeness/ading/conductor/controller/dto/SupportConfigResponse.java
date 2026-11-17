package com.politeness.ading.conductor.controller.dto;

/**
 * Used by the desktop to decide whether "Support" is available and which limits to apply in local pre-validation.
 * The standalone (signed-out) edition can also read it anonymously.
 */
public record SupportConfigResponse(
        boolean enabled,
        boolean reportEnabled,
        boolean contactEnabled,
        int maxImages,
        long maxImageBytes,
        int maxLogs,
        long maxLogBytes,
        long maxLogArchiveBytes,
        int maxDescriptionLength) {
}
