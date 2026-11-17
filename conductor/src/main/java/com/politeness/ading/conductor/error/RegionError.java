package com.politeness.ading.conductor.error;

public enum RegionError implements BizError {

    // Per user request, both the Chinese and English UI show this same English sentence
    MAINLAND_UNAVAILABLE("REGION_001", "Unavailable region");

    private final String code;
    private final String message;

    RegionError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
