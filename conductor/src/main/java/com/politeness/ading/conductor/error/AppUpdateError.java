package com.politeness.ading.conductor.error;

public enum AppUpdateError implements BizError {

    BAD_CHANNEL    ("APP_001", "Channel must be develop, pre or release"),
    BAD_VERSION    ("APP_002", "Invalid current version format"),
    BAD_MACHINE_ID ("APP_003", "Invalid machine ID format"),
    BAD_PLATFORM   ("APP_004", "Platform must be mac or ios");

    private final String code;
    private final String message;

    AppUpdateError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
