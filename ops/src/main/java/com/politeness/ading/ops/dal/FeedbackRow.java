package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class FeedbackRow {

    private Long id;
    private String reportId;
    private String userId;
    private String terminalId;
    private String status;
    private String description;
    private LocalDateTime occurredAt;
    private LocalDateTime submittedAt;
    private String appVersion;
    private String channel;
    private String platform;
    private String arch;
    private String mode;
    private String objectPrefix;
    private String handledBy;
    private LocalDateTime statusChangedAt;
}
