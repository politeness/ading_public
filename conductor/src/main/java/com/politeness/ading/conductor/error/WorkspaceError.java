package com.politeness.ading.conductor.error;

public enum WorkspaceError implements BizError {

    WORKSPACE_NOT_FOUND    ("WORKSPACE_001", "Workspace not found"),
    NOT_WORKSPACE_OWNER    ("WORKSPACE_002", "This is not your workspace"),
    INBOX_NOT_DELETABLE    ("WORKSPACE_003", "\"No Workspace\" cannot be deleted"),
    NAME_BLANK             ("WORKSPACE_004", "Workspace name cannot be empty"),
    NAME_TOO_LONG          ("WORKSPACE_005", "Workspace name cannot exceed 100 characters"),
    PATH_BLANK             ("WORKSPACE_006", "Workspace directory cannot be empty"),
    ID_CONFLICT            ("WORKSPACE_007", "Workspace ID is already taken"),
    BAD_ID                 ("WORKSPACE_008", "Invalid workspace ID format"),
    INBOX_HAS_NO_PATH      ("WORKSPACE_009", "\"No Workspace\" has no directory"),
    PATH_TOO_LONG          ("WORKSPACE_010", "Workspace directory cannot exceed 1024 characters");

    private final String code;
    private final String message;

    WorkspaceError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
