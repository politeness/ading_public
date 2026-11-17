package com.politeness.ading.ops.dal;

import java.time.LocalDateTime;
import lombok.Getter;
import lombok.Setter;

@Getter
@Setter
public class ContactRow {

    private Long id;
    private String contactId;
    private String userId;
    private String terminalId;
    private String subject;
    private String content;
    private String replyTo;
    private LocalDateTime submittedAt;
    private String appVersion;
    private String channel;
    private String platform;
    private String arch;
    private String mode;
}
