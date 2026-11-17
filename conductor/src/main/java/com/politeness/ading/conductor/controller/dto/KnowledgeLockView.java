package com.politeness.ading.conductor.controller.dto;

/** Lock acquisition result. If not acquired, token is empty; retry after retryAfterSeconds. If acquired, renew within ttlSeconds */
public record KnowledgeLockView(boolean granted, String token, long ttlSeconds, long retryAfterSeconds) {
}
