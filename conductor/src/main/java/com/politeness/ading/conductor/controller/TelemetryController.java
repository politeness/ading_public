package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.ClientIp;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.OptionalUser;
import com.politeness.ading.conductor.controller.dto.TelemetryReportRequest;
import com.politeness.ading.conductor.service.TelemetryService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.net.InetAddress;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Device telemetry. The standalone edition must report without logging in, so this does not require login (see WebMvcConfig);
 * if a token is sent, the account in the token is authoritative.
 *
 * Only reports made while the window is in the foreground are accepted. Desktop versions 0.11.2 and earlier reported to /startup in the background on launch and day change;
 * that path no longer accepts reports: accepting them would count computers whose UI was never opened as daily active.
 */
@RestController
@RequestMapping("/api/v1/telemetry")
public class TelemetryController {

    private final TelemetryService telemetryService;
    private final OptionalUser optionalUser;

    public TelemetryController(TelemetryService telemetryService, OptionalUser optionalUser) {
        this.telemetryService = telemetryService;
        this.optionalUser = optionalUser;
    }

    @PostMapping("/foreground")
    public Result<Void> foreground(
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @Valid @RequestBody TelemetryReportRequest request,
            HttpServletRequest http) {
        telemetryService.report(request, optionalUser.userId(authorization), clientIp(http));
        return Result.ok();
    }

    static String clientIp(HttpServletRequest http) {
        return ClientIp.of(http);
    }
}
