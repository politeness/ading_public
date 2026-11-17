package com.politeness.ading.ops.common;

import com.politeness.ading.ops.config.OpsProperties;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Component;

/**
 * The ops session lives only in a cookie and is never given to page scripts.
 *
 * HttpOnly keeps XSS from stealing the session; SameSite=Strict keeps other sites from sending requests with the cookie,
 * which is also a CSRF defence for every ops console endpoint beyond the read-only GETs.
 * Path is limited to /ading/ops, so the same-origin ADing intro page and conductor endpoints can't get this cookie.
 */
@Component
public class SessionCookies {

    private final OpsProperties properties;
    private final String cookiePath;

    public SessionCookies(OpsProperties properties,
                          @Value("${server.servlet.context-path:}") String contextPath) {
        this.properties = properties;
        // Not taken from request.getContextPath(): when the context path is unavailable it degrades to "/",
        // and then this cookie would also be sent to the same-origin intro page and conductor endpoints, needlessly widening exposure.
        this.cookiePath = contextPath == null || contextPath.isBlank() ? "/" : contextPath.trim();
    }

    public void grant(HttpServletResponse response, String token) {
        response.addHeader(HttpHeaders.SET_COOKIE, build(token, properties.getSessionTtlSeconds()));
    }

    public void revoke(HttpServletResponse response) {
        response.addHeader(HttpHeaders.SET_COOKIE, build("", 0L));
    }

    public String read(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        String name = properties.getCookieName();
        for (Cookie cookie : cookies) {
            if (name.equals(cookie.getName())) {
                String value = cookie.getValue();
                return value == null || value.isBlank() ? null : value;
            }
        }
        return null;
    }

    private String build(String token, long maxAgeSeconds) {
        return ResponseCookie.from(properties.getCookieName(), token)
                .httpOnly(true)
                .secure(properties.isCookieSecure())
                .sameSite("Strict")
                .path(cookiePath)
                .maxAge(maxAgeSeconds)
                .build()
                .toString();
    }
}
