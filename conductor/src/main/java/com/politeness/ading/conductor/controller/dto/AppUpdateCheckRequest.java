package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * Input for the client update check (shared by desktop and mobile).
 *
 * platform is mac or ios; old desktop clients omit it and it is treated as mac.
 * machineId is a hash of the computer's hardware UUID (the same value as terminals.fingerprint);
 * the standalone edition has no account and relies on it for gray release; the connected edition also sends the access token after login, so the account can match too.
 */
public record AppUpdateCheckRequest(
        @NotBlank @Size(max = 20) String channel,
        @NotBlank @Size(max = 30) String arch,
        @NotBlank @Size(max = 50) String currentVersion,
        @Size(max = 128) String machineId,
        @Size(max = 10) String platform) {

    /** Old clients are desktop only and do not send platform */
    public AppUpdateCheckRequest(String channel, String arch, String currentVersion, String machineId) {
        this(channel, arch, currentVersion, machineId, null);
    }
}
