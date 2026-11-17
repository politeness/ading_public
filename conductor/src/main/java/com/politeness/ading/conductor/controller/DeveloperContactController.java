package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.controller.dto.DeveloperContactRequest;
import com.politeness.ading.conductor.controller.dto.DeveloperContactResponse;
import com.politeness.ading.conductor.service.SupportReportService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/support/contacts")
public class DeveloperContactController {

    private final SupportReportService supportReportService;

    public DeveloperContactController(SupportReportService supportReportService) {
        this.supportReportService = supportReportService;
    }

    @PostMapping
    public Result<DeveloperContactResponse> submit(@Valid @RequestBody DeveloperContactRequest request) {
        return Result.ok(supportReportService.notifyDeveloper(request));
    }
}
