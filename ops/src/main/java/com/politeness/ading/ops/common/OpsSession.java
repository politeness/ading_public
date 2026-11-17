package com.politeness.ading.ops.common;

import java.time.LocalDateTime;

/** The authenticated ops session of the current request, placed in a request attribute by OpsAuthInterceptor. */
public record OpsSession(String userId, String username, String displayName, LocalDateTime expiresAt) {
}
