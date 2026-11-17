package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * workspaces — what a conversation belongs to; also the unit for sharing workspace-level skills and memory.
 *
 * Every account has exactly one INBOX ("No workspace"): conversations not in any project go there,
 * so "resolving the sharing scope" always has a single path. path is only valid on the terminal_id computer.
 */
@Data
public class WorkspaceEntity {
    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        workspaceId;
    private String        owner;
    private String        terminalId;
    private String        name;
    private String        path;
    private String        kind;

    public static final String KIND_FOLDER = "FOLDER";
    public static final String KIND_INBOX  = "INBOX";

    public static final String INBOX_NAME = "无工作区";
}
