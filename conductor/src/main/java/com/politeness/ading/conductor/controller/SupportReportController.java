package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.controller.dto.SupportConfigResponse;
import com.politeness.ading.conductor.controller.dto.SupportReportRequest;
import com.politeness.ading.conductor.controller.dto.SupportReportResponse;
import com.politeness.ading.conductor.service.SupportReportService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * "Support" is a capability the standalone edition needs too; these endpoints are exempt from authentication in WebMvcConfig.
 */
@RestController
@RequestMapping("/api/v1/support")
public class SupportReportController {

    private final SupportReportService supportReportService;

    public SupportReportController(SupportReportService supportReportService) {
        this.supportReportService = supportReportService;
    }

    /** On startup the desktop probes whether the support service is available and which limits to pre-validate against locally. */
    @GetMapping("/config")
    public Result<SupportConfigResponse> config() {
        return Result.ok(supportReportService.config());
    }

    @PostMapping("/reports")
    public Result<SupportReportResponse> submit(@Valid @RequestBody SupportReportRequest request) {
        return Result.ok(supportReportService.uploadAndNotify(request));
    }
}
