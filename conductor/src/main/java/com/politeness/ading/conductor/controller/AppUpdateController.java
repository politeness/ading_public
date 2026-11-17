package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.OptionalUser;
import com.politeness.ading.conductor.controller.dto.AppUpdateCheckRequest;
import com.politeness.ading.conductor.controller.dto.AppUpdateCheckResponse;
import com.politeness.ading.conductor.service.AppUpdateService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Client update check.
 *
 * The standalone edition must be able to check without logging in, so this path does not require login (see WebMvcConfig).
 * If a token is sent it must be valid: an expired token returns 401, and the client refreshes the token and retries,
 * instead of quietly being treated as not logged in - otherwise gray-release accounts would mysteriously not receive the version while the token is expired.
 */
@RestController
@RequestMapping("/api/v1/app/updates")
public class AppUpdateController {

    private final AppUpdateService appUpdateService;
    private final OptionalUser optionalUser;

    public AppUpdateController(AppUpdateService appUpdateService, OptionalUser optionalUser) {
        this.appUpdateService = appUpdateService;
        this.optionalUser = optionalUser;
    }

    @PostMapping("/check")
    public Result<AppUpdateCheckResponse> check(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @Valid @RequestBody AppUpdateCheckRequest request) {
        return Result.ok(appUpdateService.check(request, optionalUser.userId(authorization)));
    }
}
