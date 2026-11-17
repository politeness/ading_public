package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.common.Result;
import com.politeness.ading.ops.controller.dto.SupportDtos.ContactIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackPage;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackView;
import com.politeness.ading.ops.controller.dto.SupportDtos.IngestResult;
import com.politeness.ading.ops.service.SupportInboxService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.io.IOException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Service-to-service endpoints; token validation is in InternalTokenInterceptor.
 * conductor stores reports here; the feedback-handling workflow reads accepted reports, claims, fixes and verifies them, and the claimant may close them itself.
 */
@RestController
@RequestMapping("/api/internal")
public class OpsInternalController {

    private final SupportInboxService inbox;
    private final AttachmentResponses attachments;

    public OpsInternalController(SupportInboxService inbox, AttachmentResponses attachments) {
        this.inbox = inbox;
        this.attachments = attachments;
    }

    @PostMapping("/feedback")
    public Result<IngestResult> ingestFeedback(@Valid @RequestBody FeedbackIngest request) {
        return Result.ok(inbox.ingestFeedback(request));
    }

    @PostMapping("/contacts")
    public Result<IngestResult> ingestContact(@Valid @RequestBody ContactIngest request) {
        return Result.ok(inbox.ingestContact(request));
    }

    @GetMapping("/feedback")
    public Result<FeedbackPage> feedback(@RequestParam String status,
                                         @RequestParam(defaultValue = "1") int page,
                                         @RequestParam(defaultValue = "50") int size) {
        return Result.ok(inbox.feedback(status, page, size));
    }

    @GetMapping("/feedback/{reportId}")
    public Result<FeedbackView> feedbackDetail(@PathVariable String reportId) {
        return Result.ok(inbox.feedbackDetail(reportId));
    }

    @PostMapping("/feedback/{reportId}/claim")
    public Result<FeedbackView> claim(@PathVariable String reportId, @RequestParam String operator) {
        return Result.ok(inbox.claim(reportId, operator));
    }

    @PostMapping("/feedback/{reportId}/resolve")
    public Result<FeedbackView> resolve(@PathVariable String reportId, @RequestParam String operator) {
        return Result.ok(inbox.resolve(reportId, operator));
    }

    @GetMapping("/attachments/{id}")
    public void attachment(@PathVariable long id, HttpServletResponse response) throws IOException {
        attachments.write(inbox.attachment(id), response);
    }
}
