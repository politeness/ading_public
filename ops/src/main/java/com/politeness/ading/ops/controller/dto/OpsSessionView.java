package com.politeness.ading.ops.controller.dto;

import java.time.LocalDateTime;

/**
 * zone is the time zone the server uses to interpret all times (IANA name, e.g. Asia/Shanghai). Times in the API carry no zone;
 * the page uses it to decide "today / yesterday", so browsers outside UTC+8 don't mislabel dates.
 */
public record OpsSessionView(
        String username,
        String displayName,
        String userId,
        LocalDateTime expiresAt,
        String zone) {
}
