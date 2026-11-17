package com.politeness.ading.ops.controller.dto;

import java.time.LocalDateTime;

/**
 * One distinct person or terminal within the selected activity window.
 * activeHours is the sum of connected time, null when there is no session in the window (history before
 * sessions were recorded, standalone devices): not recorded, not zero.
 */
public record ActiveMemberView(String memberId, String name, String username, String deviceType,
                               LocalDateTime lastActiveAt, Double activeHours, long terminalCount, DeviceView device) {}
