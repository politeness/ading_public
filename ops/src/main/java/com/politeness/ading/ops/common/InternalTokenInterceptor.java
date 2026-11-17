package com.politeness.ading.ops.common;

import com.politeness.ading.ops.config.OpsProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Guards /api/internal/**: service-to-service endpoints for conductor reporting and for processing-flow queries and status changes; no ops session, a shared token instead.
 * Without a configured token everything is rejected, so a missing setting can't make it publicly writable.
 */
@Slf4j
@Component
public class InternalTokenInterceptor implements HandlerInterceptor {

    public static final String HEADER = "X-Ops-Internal-Token";

    private final byte[] token;

    public InternalTokenInterceptor(OpsProperties properties) {
        String configured = properties.getIngestToken() == null ? "" : properties.getIngestToken().trim();
        this.token = configured.getBytes(StandardCharsets.UTF_8);
        if (configured.isEmpty()) log.warn("ADING_OPS_INGEST_TOKEN is not configured; internal endpoints will reject all requests");
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String presented = request.getHeader(HEADER);
        if (token.length == 0 || presented == null
                || !MessageDigest.isEqual(token, presented.getBytes(StandardCharsets.UTF_8))) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        return true;
    }
}
