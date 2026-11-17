package com.politeness.ading.conductor.controller.dto;

import jakarta.validation.constraints.NotEmpty;

/**
 * Changes the caller's own password.
 *
 * The current password is required: without this step, a leaked access token would be enough to change the password and take over the account.
 * As with registration, the new password has no complexity rules (see RegisterRequest); it only has to be non-empty.
 */
public record PasswordChangeRequest(
        @NotEmpty String currentPassword,
        @NotEmpty String newPassword) {
}
