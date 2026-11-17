package com.politeness.ading.ops.controller.dto;

import java.time.LocalDateTime;
import java.util.List;

/**
 * One row of the device list, one row per device. accounts are all linked accounts; empty means standalone.
 * Empty status also means no linked account: ONLINE / OFFLINE / DISABLED only exist for registered devices.
 */
public record DeviceView(
        String deviceUuid,
        String deviceType,
        String name,
        String osVersion,
        String appVersion,
        String city,
        List<String> agents,
        LocalDateTime firstSeenAt,
        LocalDateTime lastActiveAt,
        String status,
        List<Account> accounts) {

    public record Account(String userId, String username, String displayName, LocalDateTime lastSeenAt, boolean online) {}
}
