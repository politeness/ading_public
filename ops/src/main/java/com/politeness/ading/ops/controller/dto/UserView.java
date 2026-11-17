package com.politeness.ading.ops.controller.dto;

import java.time.LocalDateTime;
import java.util.List;

/** One row of the registered-user list, real people only. Empty lastActiveAt means this account has no activity records. */
public record UserView(
        String userId,
        String username,
        String displayName,
        String phone,
        String email,
        String status,
        LocalDateTime registeredAt,
        long terminalCount,
        long agentCount,
        long activeTerminalCount,
        LocalDateTime lastActiveAt,
        List<String> tags,
        boolean online) {
}
