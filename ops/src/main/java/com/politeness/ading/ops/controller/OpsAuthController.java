package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.common.ClientIp;
import com.politeness.ading.ops.common.OpsAuthInterceptor;
import com.politeness.ading.ops.common.OpsSession;
import com.politeness.ading.ops.common.Result;
import com.politeness.ading.ops.common.SessionCookies;
import com.politeness.ading.ops.controller.dto.LoginRequest;
import com.politeness.ading.ops.controller.dto.OpsSessionView;
import com.politeness.ading.ops.service.OpsAuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api")
public class OpsAuthController {

    private final OpsAuthService auth;
    private final SessionCookies cookies;

    public OpsAuthController(OpsAuthService auth, SessionCookies cookies) {
        this.auth = auth;
        this.cookies = cookies;
    }

    @PostMapping("/login")
    public Result<OpsSessionView> login(@Valid @RequestBody LoginRequest request,
                                        HttpServletRequest http,
                                        HttpServletResponse response) {
        OpsAuthService.LoginResult result = auth.login(
                request.username(), request.password(), ClientIp.of(http));
        cookies.grant(response, result.token());
        return Result.ok(result.view());
    }

    @PostMapping("/logout")
    public Result<Void> logout(HttpServletResponse response) {
        cookies.revoke(response);
        return Result.ok();
    }

    @GetMapping("/me")
    public Result<OpsSessionView> me(@RequestAttribute(OpsAuthInterceptor.SESSION_ATTRIBUTE) OpsSession session) {
        return Result.ok(new OpsSessionView(
                session.username(), session.displayName(), session.userId(), session.expiresAt(), auth.zone()));
    }
}
