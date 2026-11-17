package com.politeness.ading.ops.common;

import com.politeness.ading.ops.dal.OpsAccountRow;
import com.politeness.ading.ops.dal.mapper.OpsUserMapper;
import com.politeness.ading.ops.service.OpsTokenService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * Ops session check guarding /api/**. Pages themselves aren't intercepted: static pages always open,
 * and the page script calls /api/me and switches back to the login view itself on 401.
 */
@Component
public class OpsAuthInterceptor implements HandlerInterceptor {

    public static final String SESSION_ATTRIBUTE = "ading.ops.session";

    private static final String STATUS_ACTIVE = "ACTIVE";

    private final SessionCookies cookies;
    private final OpsTokenService tokens;
    private final OpsUserMapper users;

    public OpsAuthInterceptor(SessionCookies cookies, OpsTokenService tokens, OpsUserMapper users) {
        this.cookies = cookies;
        this.tokens = tokens;
        this.users = users;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        OpsTokenService.Claims claims = tokens.parse(cookies.read(request));
        tokens.requireStillOps(claims);
        // Check generation and status against the DB on every request: if the password is changed or the account disabled in ADing, the ops session must be invalidated immediately,
        // not wait for the token to expire on its own (12 hours is too long for a leaked session)
        OpsAccountRow account = users.findSessionAccount(claims.userId());
        if (account == null || !STATUS_ACTIVE.equals(account.getStatus())
                || epochOf(account) != claims.epoch()) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        request.setAttribute(SESSION_ATTRIBUTE, new OpsSession(
                account.getUserId(), account.getUsername(), account.getDisplayName(), claims.expiresAt()));
        return true;
    }

    private static int epochOf(OpsAccountRow account) {
        return account.getTokenEpoch() == null ? 0 : account.getTokenEpoch();
    }
}
