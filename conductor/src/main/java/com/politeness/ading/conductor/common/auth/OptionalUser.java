package com.politeness.ading.conductor.common.auth;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.error.AuthError;
import org.springframework.stereotype.Component;

/**
 * Used by endpoints that do not require login (update check, device telemetry): if a token is sent it must be valid; if not, the request is treated as not logged in.
 *
 * An expired token returns 401 so the client refreshes and retries, instead of quietly being treated as not logged in -
 * otherwise per-account gray release and the account in telemetry would mysteriously mismatch while the token is expired.
 */
@Component
public class OptionalUser {

    private static final String BEARER = "Bearer ";

    private final TokenService tokenService;
    private final TokenEpochGuard epochGuard;

    public OptionalUser(TokenService tokenService, TokenEpochGuard epochGuard) {
        this.tokenService = tokenService;
        this.epochGuard = epochGuard;
    }

    /** @return the logged-in account's user_id; null when no token is sent */
    public String userId(String authorization) {
        if (authorization == null || authorization.isBlank()) {
            return null;
        }
        if (!authorization.startsWith(BEARER)) {
            throw new BizException(AuthError.TOKEN_MISSING);
        }
        TokenService.Claims claims = tokenService.parse(authorization.substring(BEARER.length()).trim());
        // Only tokens issued after the last password change are valid, using the same check as login-required endpoints
        epochGuard.verify(claims);
        return switch (claims.type()) {
            // The subject of a computer token is the account that owns the computer
            case ACCESS, NODE -> claims.subject();
            case REFRESH -> throw new BizException(AuthError.WRONG_TOKEN_TYPE);
        };
    }
}
