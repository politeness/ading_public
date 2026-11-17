package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

public record NodeRegisterRequest(
        @NotBlank @Size(max = 128) String fingerprint,
        @Size(max = 100) String name,
        @NotBlank @jakarta.validation.constraints.Pattern(regexp = "DESKTOP|MOBILE") String type,
        @Size(max = 50) String appVersion,
        @Size(max = 64) String osVersion) {
    public NodeRegisterRequest(String fingerprint, String name) { this(fingerprint, name, "DESKTOP", null, null); }
    public NodeRegisterRequest(String fingerprint, String name, String type) { this(fingerprint, name, type, null, null); }
}
