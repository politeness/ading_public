package com.politeness.ading.conductor.error;

public enum KnowledgeError implements BizError {

    BAD_KIND    ("KNOW_001", "Invalid knowledge kind"),
    BAD_NAME    ("KNOW_002", "Invalid knowledge object name"),
    TOO_MANY    ("KNOW_003", "Too many URLs requested at once"),
    LOCK_LOST   ("KNOW_004", "Sync lock has expired");

    private final String code;
    private final String message;

    KnowledgeError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
