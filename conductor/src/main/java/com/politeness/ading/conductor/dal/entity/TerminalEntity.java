package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** terminals — a terminal: a computer (DESKTOP, executor) or a phone (MOBILE, only sends/receives messages, does not run Agents) */
@Data
public class TerminalEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        terminalId;
    private String        name;
    private String        type = TYPE_DESKTOP;
    private String        fingerprint;
    private String        status;
    private String        owner;

    public static final String TYPE_DESKTOP = "DESKTOP";
    public static final String TYPE_MOBILE  = "MOBILE";

    public static final String STATUS_ONLINE   = "ONLINE";
    public static final String STATUS_OFFLINE  = "OFFLINE";
    public static final String STATUS_DISABLED = "DISABLED";

    /** Only computers can run Agents: registering Agents, reporting Agent state and progress, and binding working directories all require an executor */
    public boolean isExecutionTerminal() {
        return TYPE_DESKTOP.equals(type);
    }
}
