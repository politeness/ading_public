package com.politeness.ading.ops.dal;
import java.time.LocalDateTime;
import lombok.Data;
@Data
public class OpsAgentRow {
    private String userId, username, displayName, agentType, owner, ownerName, status;
    private LocalDateTime registeredAt;
    private boolean contact;
}
