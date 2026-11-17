package com.politeness.ading.conductor.error;

/**
 * For TurnService in phase 2; error codes are fixed in phase 1 to avoid clashing with existing codes later.
 */
public enum TurnError implements BizError {

    CONVERSATION_BUSY   ("TURN_001", "The conversation already has a turn in progress"),
    NO_ELIGIBLE_SPEAKER ("TURN_002", "No member is eligible to speak"),
    NODE_OFFLINE        ("TURN_003", "The Agent's node is offline"),
    TURN_TIMEOUT        ("TURN_004", "The Agent did not respond in time"),
    BUDGET_EXHAUSTED    ("TURN_005", "The discussion budget for this round is used up");

    private final String code;
    private final String message;

    TurnError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
