package com.politeness.ading.conductor.error;

public enum NodeError implements BizError {

    NODE_NOT_FOUND    ("NODE_001", "Desktop node not found"),
    NODE_DISABLED     ("NODE_002", "Desktop node is disabled"),
    NODE_OFFLINE      ("NODE_003", "Desktop node is offline"),
    NOT_NODE_OWNER    ("NODE_004", "This desktop node does not belong to the current user"),
    FINGERPRINT_BLANK ("NODE_005", "Device fingerprint cannot be empty"),
    /** MQTT connection lookup failed: we don't know whether the computer is online, so treat it neither as offline nor as online for dispatch */
    PRESENCE_UNKNOWN  ("NODE_006", "Unable to confirm whether the computer is online; please try again later"),
    /** Mobile terminals are auxiliary: they can send and receive messages but cannot register or run Agents */
    NOT_EXECUTION_TERMINAL("NODE_007", "Only computers can run Agents; phone terminals cannot perform this action");

    private final String code;
    private final String message;

    NodeError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
