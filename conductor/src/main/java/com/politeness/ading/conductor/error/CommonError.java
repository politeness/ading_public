package com.politeness.ading.conductor.error;

public enum CommonError implements BizError {

    OK              ("OK",         "Success"),
    BAD_REQUEST     ("COMMON_001", "Invalid request parameters"),
    NOT_FOUND       ("COMMON_002", "Resource not found"),
    FORBIDDEN       ("COMMON_003", "No permission to perform this action"),
    INTERNAL_ERROR  ("COMMON_004", "Internal server error"),
    NOT_IMPLEMENTED ("COMMON_005", "This capability is not implemented yet");

    private final String code;
    private final String message;

    CommonError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
