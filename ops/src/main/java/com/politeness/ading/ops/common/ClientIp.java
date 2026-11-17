package com.politeness.ading.ops.common;

import jakarta.servlet.http.HttpServletRequest;

/**
 * Gets the client IP, used only for login rate limiting.
 *
 * The service listens only on 127.0.0.1, so the only thing that can connect is nginx on the same host, and nginx overwrites
 * X-Real-IP with $remote_addr, so the value read here can't be forged by the browser.
 * If it ever listens directly on the public network, this assumption breaks and rate limiting must change implementation.
 */
public final class ClientIp {

    private ClientIp() {
    }

    public static String of(HttpServletRequest request) {
        String realIp = request.getHeader("X-Real-IP");
        if (realIp != null && !realIp.isBlank()) {
            return realIp.trim();
        }
        String forwarded = request.getHeader("X-Forwarded-For");
        if (forwarded != null && !forwarded.isBlank()) {
            return forwarded.split(",")[0].trim();
        }
        return request.getRemoteAddr();
    }
}
