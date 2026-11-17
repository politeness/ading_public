package com.politeness.ading.ops.common;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpHeaders;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Adds no-cache headers to every /api/** response.
 *
 * User and device endpoints carry phone numbers and emails, the login endpoint carries the session cookie; neither browser caches nor intermediate proxies should keep copies.
 * Set it in preHandle, so the header is present even when later session checks throw 401 or endpoints throw business errors.
 */
public class NoStoreInterceptor implements HandlerInterceptor {

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
        response.setHeader(HttpHeaders.PRAGMA, "no-cache");
        return true;
    }
}
