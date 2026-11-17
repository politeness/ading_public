package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

/** One account linked to a device (a row of terminals). */
@Getter
@Setter
public class OpsDeviceAccountRow {

    private String deviceUuid;
    private String terminalId;
    private String userId;
    private String username;
    private String displayName;
    private LocalDateTime lastSeenAt;
    private boolean online;
}
