package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** users — humans and agents stored together */
@Data
public class UserEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        userId;
    private String        username;
    private String        displayName;
    private String        avatarUrl;
    private String        phone;
    private String        email;
    private Boolean       isAgent;
    private String        password;
    private String        status;
    private String        agentType;
    private String        agentVersion;
    private String        permissionLevel;
    private String        persona;
    private String        owner;
    /** The computer the Agent lives on. An Agent belongs to exactly one computer, so it is stored on the Agent directly, no relation table; empty for humans */
    private String        terminalId;
    /** The Agent's local identifier on its computer; registration is idempotent on (terminalId, localUuid); empty for humans */
    private String        localUuid;
    /** The Agent's readiness on its computer, reported by that computer (see AgentStateService); empty for humans */
    private String        readiness;
    /** The Agent's current model (JSON, see AgentModelState), reported by its computer; empty for Agents on old clients and for humans */
    private String        modelState;
    /** Token generation: incremented on password change; any token older than it is invalidated (see auth/TokenService) */
    private Integer       tokenEpoch;

    public static final String STATUS_ACTIVE   = "ACTIVE";
    public static final String STATUS_DISABLED = "DISABLED";
    /** Agents only: set only when detection completed normally and definitely found nothing; on detection errors the state is kept */
    public static final String STATUS_NOT_INSTALLED = "NOT_INSTALLED";
}
