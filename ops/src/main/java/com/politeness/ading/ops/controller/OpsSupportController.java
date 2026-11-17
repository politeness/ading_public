package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.common.OpsAuthInterceptor;
import com.politeness.ading.ops.common.OpsSession;
import com.politeness.ading.ops.common.Result;
import com.politeness.ading.ops.controller.dto.PageView;
import com.politeness.ading.ops.controller.dto.SupportDtos.ContactView;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackPage;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackView;
import com.politeness.ading.ops.controller.dto.SupportDtos.StatusChange;
import com.politeness.ading.ops.service.SupportInboxService;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import java.io.IOException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Issue report and user contact endpoints for the ops pages; all require an ops session.
 * Changing status is one of the console's few write operations: the session cookie is SameSite=Strict and the body must be JSON, so other sites can't send it.
 */
@RestController
@RequestMapping("/api")
public class OpsSupportController {

    private final SupportInboxService inbox;
    private final AttachmentResponses attachments;

    public OpsSupportController(SupportInboxService inbox, AttachmentResponses attachments) {
        this.inbox = inbox;
        this.attachments = attachments;
    }

    @GetMapping("/feedback")
    public Result<FeedbackPage> feedback(@RequestParam(required = false) String status,
                                         @RequestParam(defaultValue = "1") int page,
                                         @RequestParam(defaultValue = "20") int size) {
        return Result.ok(inbox.feedback(status, page, size));
    }

    @GetMapping("/feedback/{reportId}")
    public Result<FeedbackView> feedbackDetail(@PathVariable String reportId) {
        return Result.ok(inbox.feedbackDetail(reportId));
    }

    @PostMapping("/feedback/{reportId}/status")
    public Result<FeedbackView> changeStatus(@PathVariable String reportId,
                                             @Valid @RequestBody StatusChange change,
                                             @RequestAttribute(OpsAuthInterceptor.SESSION_ATTRIBUTE) OpsSession session) {
        return Result.ok(inbox.changeStatus(reportId, change.status(), session.username()));
    }

    @GetMapping("/contacts")
    public Result<PageView<ContactView>> contacts(@RequestParam(defaultValue = "1") int page,
                                                  @RequestParam(defaultValue = "20") int size) {
        return Result.ok(inbox.contacts(page, size));
    }

    @GetMapping("/contacts/{contactId}")
    public Result<ContactView> contactDetail(@PathVariable String contactId) {
        return Result.ok(inbox.contactDetail(contactId));
    }

    @GetMapping("/attachments/{id}")
    public void attachment(@PathVariable long id, HttpServletResponse response) throws IOException {
        attachments.write(inbox.attachment(id), response);
    }
}
