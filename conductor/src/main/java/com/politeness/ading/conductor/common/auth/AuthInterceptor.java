package com.politeness.ading.conductor.common.auth;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.error.AuthError;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Parses Authorization: Bearer <token> and puts the identity into AuthContext.
 * Permitted paths are configured in WebMvcConfig; this only handles parsing.
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    private static final String BEARER = "Bearer ";

    private final TokenService tokenService;
    private final TokenEpochGuard epochGuard;

    public AuthInterceptor(TokenService tokenService, TokenEpochGuard epochGuard) {
        this.tokenService = tokenService;
        this.epochGuard = epochGuard;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String header = request.getHeader("Authorization");
        if (header == null || !header.startsWith(BEARER)) {
            throw new BizException(AuthError.TOKEN_MISSING);
        }
        TokenService.Claims claims = tokenService.parse(header.substring(BEARER.length()).trim());
        // After a password change, previously issued access tokens and computer tokens become invalid here
        epochGuard.verify(claims);
        AuthContext.set(switch (claims.type()) {
            case ACCESS -> Principal.ofUser(claims.subject());
            case NODE   -> Principal.ofNode(claims.subject(), claims.terminalId());
            case REFRESH -> throw new BizException(AuthError.WRONG_TOKEN_TYPE);
        });
        return true;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        AuthContext.clear();
    }
}
