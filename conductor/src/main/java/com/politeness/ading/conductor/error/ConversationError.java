package com.politeness.ading.conductor.error;

public enum ConversationError implements BizError {

    CONVERSATION_NOT_FOUND         ("CONVERSATION_001", "Conversation not found"),
    NOT_A_MEMBER           ("CONVERSATION_002", "You are not a member of this conversation"),
    DIRECT_NEEDS_TWO       ("CONVERSATION_003", "A direct chat must have exactly two members"),
    NEEDS_NAME             ("CONVERSATION_004", "The conversation must have a name"),
    MEMBER_ALREADY_IN      ("CONVERSATION_005", "This member is already in the conversation"),
    MEMBER_NOT_IN          ("CONVERSATION_006", "This member is not in the conversation"),
    CANNOT_REMOVE_OWNER    ("CONVERSATION_007", "The conversation owner cannot be removed"),
    BAD_ROLE               ("CONVERSATION_008", "Invalid conversation role"),
    BAD_TYPE               ("CONVERSATION_009", "Invalid conversation type"),
    NOT_FRIEND             ("CONVERSATION_010", "Conversations can only be created with friends or your own Agents"),
    CONVERSATION_ID_CONFLICT       ("CONVERSATION_011", "Conversation ID is already taken"),
    NOT_OWNER              ("CONVERSATION_012", "Only the conversation owner can delete it"),
    BAD_STATUS             ("CONVERSATION_013", "Invalid conversation status"),
    BAD_ID                 ("CONVERSATION_014", "Invalid conversation ID format"),
    NEEDS_MEMBER           ("CONVERSATION_015", "Add at least one member"),
    AGENT_PRIVATE          ("CONVERSATION_016", "Every person in the conversation must own or be allowed to use all Agents"),
    CANNOT_REMOVE_AGENT_OWNER ("CONVERSATION_018", "Remove this owner's Agents before removing the owner"),
    OWNER_PAUSED           ("CONVERSATION_017", "A shared Agent has been paused by its owner; messages cannot be sent right now");

    private final String code;
    private final String message;

    ConversationError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
