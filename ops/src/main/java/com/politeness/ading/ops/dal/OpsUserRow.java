package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

/** One row of the registered-user list. Only real people appear here; Agents are summarised in agentCount. */
@Getter
@Setter
public class OpsUserRow {

    private String userId;
    private String username;
    private String displayName;
    private String phone;
    private String email;
    private String status;
    private LocalDateTime registeredAt;
    private int terminalCount;
    private int agentCount;
    /** Registered terminals this account actually used online in the last 30 days */
    private int activeTerminalCount;
    private LocalDateTime lastReportAt;
    private LocalDateTime lastSeenAt;
    private boolean online;
    /** Comma-separated tag keys; empty when there are no tags */
    private String tags;

    /** Compatibility response field; in the Mapper both times read real online usage; empty if none */
    public LocalDateTime getLastActiveAt() {
        if (lastReportAt == null) return lastSeenAt;
        return lastSeenAt == null || lastReportAt.isAfter(lastSeenAt) ? lastReportAt : lastSeenAt;
    }
}
