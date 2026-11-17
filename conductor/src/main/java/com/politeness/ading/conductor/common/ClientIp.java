package com.politeness.ading.conductor.common;

import jakarta.servlet.http.HttpServletRequest;
import java.net.InetAddress;
import java.util.function.Function;

/**
 * The requester's real IP.
 *
 * The X-Real-IP / X-Forwarded-For it forwards is trusted only when the request comes from a reverse proxy (Nginx) on this host or the internal network;
 * external direct requests use the connection's own address, so forged request headers cannot change the result.
 */
public final class ClientIp {

    private ClientIp() {
    }

    public static String of(HttpServletRequest http) {
        return of(http.getRemoteAddr(), http::getHeader);
    }

    public static String of(String remote, Function<String, String> header) {
        try {
            InetAddress address = InetAddress.ofLiteral(remote);
            if (address.isLoopbackAddress() || address.isSiteLocalAddress()) {
                String real = header.apply("X-Real-IP");
                if (real != null && !real.isBlank()) return real.trim();
                String forwarded = header.apply("X-Forwarded-For");
                if (forwarded != null && !forwarded.isBlank()) return forwarded.split(",")[0].trim();
            }
        } catch (Exception ignored) {
            // If the address cannot be parsed, use the raw value
        }
        return remote;
    }
}
