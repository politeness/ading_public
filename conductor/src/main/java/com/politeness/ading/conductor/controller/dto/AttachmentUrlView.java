package com.politeness.ading.conductor.controller.dto;

import java.time.Instant;

/** Time-limited download URL; fetch a new one after it expires */
public record AttachmentUrlView(String url, Instant expiresAt) {
}
