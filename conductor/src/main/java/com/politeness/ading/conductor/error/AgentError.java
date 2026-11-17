package com.politeness.ading.conductor.error;

public enum AgentError implements BizError {

    AGENT_NOT_FOUND      ("AGENT_001", "Agent not found"),
    NOT_AGENT_OWNER      ("AGENT_002", "This Agent does not belong to the current user"),
    NOT_ON_THIS_NODE     ("AGENT_003", "This Agent is not on the current desktop node"),
    UNSUPPORTED_TYPE     ("AGENT_004", "Unsupported Agent type"),
    BAD_PERMISSION_LEVEL ("AGENT_005", "Invalid permission level"),
    DISPLAY_NAME_BLANK   ("AGENT_006", "Display name cannot be empty"),
    DISPLAY_NAME_TOO_LONG("AGENT_007", "Display name cannot exceed 30 characters"),
    SESSION_NOT_FOUND    ("AGENT_008", "No resume record for this Agent in this conversation"),
    AGENT_OFFLINE        ("AGENT_009", "The Agent's computer is offline; its state cannot be updated right now");

    private final String code;
    private final String message;

    AgentError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
