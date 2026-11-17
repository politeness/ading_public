package com.politeness.ading.conductor.error;

public enum MessageError implements BizError {

    CONTENT_BLANK    ("MSG_001", "Message content cannot be empty"),
    CONTENT_TOO_LONG ("MSG_002", "Message content cannot exceed 200000 characters"),
    BAD_MESSAGE_ID   ("MSG_003", "Invalid message_id"),
    SENDER_NOT_MEMBER("MSG_004", "Sender is not a member of this conversation"),
    BAD_MENTION      ("MSG_005", "The mentioned member is not in this conversation"),
    REPLY_NOT_FOUND  ("MSG_006", "The replied-to message does not exist"),
    SEQ_CONFLICT     ("MSG_007", "Sequence conflict, please retry"),
    NOT_FRIEND       ("MSG_008", "You are no longer friends and cannot send messages"),
    CONTENT_BLOCKED  ("MSG_009", "This message contains inappropriate content and was not sent");

    private final String code;
    private final String message;

    MessageError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
