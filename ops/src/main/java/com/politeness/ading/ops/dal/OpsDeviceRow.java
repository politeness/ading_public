package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

/** One row of the device list: from devices, one row per device; linked accounts are queried separately, see {@link OpsDeviceAccountRow}. */
@Getter
@Setter
public class OpsDeviceRow {

    private String deviceUuid;
    private String deviceType;
    private String name;
    private String osVersion;
    private String appVersion;
    private String city;
    /** Comma-separated available Agents, split into an array by the service layer */
    private String agents;
    private LocalDateTime firstSeenAt;
    private LocalDateTime lastActiveAt;
    /** ONLINE / OFFLINE / DISABLED; empty for standalone, which has no linked account */
    private String status;
}
