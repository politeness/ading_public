package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

public record PushDeviceRequest(
        @NotBlank @Pattern(regexp = "[0-9a-fA-F]{32,200}") String deviceToken,
        @NotBlank @Pattern(regexp = "sandbox|production") String environment,
        @NotBlank @Pattern(regexp = "zh|en") String language) {
}
