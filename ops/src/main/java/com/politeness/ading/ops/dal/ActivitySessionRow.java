package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

/** One activity record or online interval; a foreground ping is a single instant with onlineAt = endedAt. onlineAt keeps the existing internal field name but actually comes from started_at. */
@Getter
@Setter
public class ActivitySessionRow {

    private String deviceUuid;
    private String userId;
    private String deviceType;
    private LocalDateTime onlineAt;
    private LocalDateTime endedAt;
}
