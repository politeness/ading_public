package com.politeness.ading.conductor.error;

/** Validation of the user's own profile. Messages and limits stay consistent with desktop src/store/profile-patch.ts */
public enum ProfileError implements BizError {

    USER_NOT_FOUND         ("PROFILE_001", "User not found"),
    DISPLAY_NAME_BLANK     ("PROFILE_002", "Display name cannot be empty"),
    DISPLAY_NAME_TOO_LONG  ("PROFILE_003", "Display name cannot exceed 30 characters"),
    BAD_AVATAR             ("PROFILE_004", "Invalid avatar format"),
    AVATAR_TOO_LARGE       ("PROFILE_005", "Avatar cannot exceed 1 MB"),
    PHONE_TOO_LONG         ("PROFILE_006", "Phone number cannot exceed 30 characters"),
    EMAIL_TOO_LONG         ("PROFILE_007", "Email cannot exceed 254 characters");

    private final String code;
    private final String message;

    ProfileError(String code, String message) {
        this.code = code;
        this.message = message;
    }

    @Override public String code() { return code; }
    @Override public String message() { return message; }
}
