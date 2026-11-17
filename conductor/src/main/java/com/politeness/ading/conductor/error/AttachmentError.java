package com.politeness.ading.conductor.error;

public enum AttachmentError implements BizError {

    BAD_ID          ("FILE_001", "Invalid attachment ID"),
    BAD_NAME        ("FILE_002", "Invalid attachment file name"),
    TOO_LARGE       ("FILE_003", "Each attachment cannot exceed 200 MB"),
    TOO_MANY        ("FILE_004", "A message can carry at most 9 attachments"),
    NOT_FOUND       ("FILE_005", "Attachment not found"),
    NOT_UPLOADED    ("FILE_006", "Attachment upload is not complete"),
    ALREADY_SENT    ("FILE_007", "Attachment was already sent in another message"),
    UNAVAILABLE     ("FILE_008", "Attachment service is temporarily unavailable");

    private final String code;
    private final String message;

    AttachmentError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
