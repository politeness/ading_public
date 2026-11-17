package com.politeness.ading.conductor.controller.dto;

/** Updates a member: role, pause in this conversation only, and whether to auto-resume when the conversation continues. Omitted fields are left unchanged */
public record MemberUpdateRequest(String role, Boolean paused, Boolean resumeOnContinue) {
}
