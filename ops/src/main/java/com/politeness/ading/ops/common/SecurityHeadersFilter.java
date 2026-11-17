package com.politeness.ading.ops.common;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Adds a Content Security Policy (CSP) to every response.
 *
 * The page only loads this site's app.js / app.css / icon.svg and only calls this site's api/; the browser therefore refuses to run any inline or third-party script,
 * so even if HTML is someday injected into the page, the injected script can't run. frame-ancestors 'none' (plus X-Frame-Options for old browsers)
 * stops other sites from embedding the ops console in an iframe for clickjacking. So index.html must not contain inline <script>/<style>, inline event handlers or style attributes.
 */
@Component
public class SecurityHeadersFilter extends OncePerRequestFilter {

    static final String POLICY = String.join("; ",
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data:",
            "connect-src 'self'",
            "font-src 'self'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'self'",
            "frame-ancestors 'none'");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        response.setHeader("Content-Security-Policy", POLICY);
        response.setHeader("X-Frame-Options", "DENY");
        chain.doFilter(request, response);
    }
}
