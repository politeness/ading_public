package com.politeness.ading.ops.controller.dto;
import java.time.LocalDateTime;
public record AgentView(String userId, String username, String displayName, String agentType,
                        String owner, String ownerName, String status, LocalDateTime registeredAt, boolean contact) {}
