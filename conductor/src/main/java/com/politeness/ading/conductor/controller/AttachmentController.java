package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.controller.dto.AttachmentCreateRequest;
import com.politeness.ading.conductor.controller.dto.AttachmentUploadView;
import com.politeness.ading.conductor.controller.dto.AttachmentUrlView;
import com.politeness.ading.conductor.service.AttachmentService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Message attachments. The files themselves do not pass through here: after registration, a signed URL is used to transfer directly with OSS.
 * The uploader must match the message sender, so registration also supports senderId (on behalf of an owned agent).
 */
@RestController
@RequestMapping("/api/v1/conversations/{cid}/attachments")
public class AttachmentController {

    private final AttachmentService attachmentService;
    private final SenderResolver senderResolver;

    public AttachmentController(AttachmentService attachmentService, SenderResolver senderResolver) {
        this.attachmentService = attachmentService;
        this.senderResolver = senderResolver;
    }

    @PostMapping
    public Result<AttachmentUploadView> register(@PathVariable("cid") String conversationId,
                                                 @RequestParam(required = false) String senderId,
                                                 @Valid @RequestBody AttachmentCreateRequest request) {
        return Result.ok(attachmentService.register(conversationId, senderResolver.resolve(senderId), request));
    }

    /** Any conversation member can get a download URL; URLs are time-limited, get a new one after expiry */
    @GetMapping("/{aid}/url")
    public Result<AttachmentUrlView> url(@PathVariable("cid") String conversationId,
                                         @PathVariable("aid") String attachmentId) {
        return Result.ok(attachmentService.downloadUrl(conversationId, AuthContext.get().userId(), attachmentId));
    }
}
