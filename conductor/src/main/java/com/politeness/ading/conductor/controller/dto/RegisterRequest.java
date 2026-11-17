package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Size;

public record RegisterRequest(
        @NotBlank @Size(max = 64) String username,
        // No length or complexity rules for passwords for now; whatever the user sets is accepted, it only has to be non-empty. Add them back when needed
        @NotEmpty String password,
        @Size(max = 64) String displayName) {
}
