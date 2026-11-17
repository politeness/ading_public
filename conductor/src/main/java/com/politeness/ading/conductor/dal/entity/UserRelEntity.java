package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/** users_rel — friend relations, stored as two rows (one per direction) */
@Data
public class UserRelEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        userId;
    private String        friendId;
    private String        status;

    public static final String STATUS_PENDING  = "PENDING";
    public static final String STATUS_ACCEPTED = "ACCEPTED";
    public static final String STATUS_BLOCKED  = "BLOCKED";
}
