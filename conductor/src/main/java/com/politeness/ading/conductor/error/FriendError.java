package com.politeness.ading.conductor.error;

public enum FriendError implements BizError {

    QUERY_BLANK      ("FRIEND_001", "Enter the other person's username, email or phone number"),
    USER_NOT_FOUND   ("FRIEND_002", "User not found"),
    SELF             ("FRIEND_003", "You cannot add yourself as a friend"),
    NOT_A_PERSON     ("FRIEND_004", "Only real people can be added as friends"),
    REQUEST_NOT_FOUND("FRIEND_005", "This friend request does not exist or has already been handled"),
    BLOCKED_BY_ME    ("FRIEND_006", "You have blocked this person; unblock them before adding"),
    UNAVAILABLE      ("FRIEND_007", "Unable to add this person as a friend right now"),
    REPORT_REASON    ("FRIEND_008", "Please choose a report reason");

    private final String code;
    private final String message;

    FriendError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
