package com.politeness.ading.conductor.error;

public enum AuthError implements BizError {

    USERNAME_TAKEN      ("AUTH_001", "Username is already taken"),
    BAD_CREDENTIALS     ("AUTH_002", "Incorrect username or password"),
    TOKEN_MISSING       ("AUTH_003", "Missing access token"),
    TOKEN_INVALID       ("AUTH_004", "Invalid access token"),
    TOKEN_EXPIRED       ("AUTH_005", "Access token has expired"),
    WRONG_TOKEN_TYPE    ("AUTH_006", "Token type mismatch"),
    ACCOUNT_DISABLED    ("AUTH_007", "Account is disabled"),
    SAME_PASSWORD       ("AUTH_008", "New password is the same as the old one"),
    TOKEN_REVOKED       ("AUTH_009", "Your session has expired; please sign in again");

    private final String code;
    private final String message;

    AuthError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
