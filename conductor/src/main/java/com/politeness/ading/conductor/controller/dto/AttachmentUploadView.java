package com.politeness.ading.conductor.controller.dto;

import java.time.Instant;

/**
 * Registration result: the client PUTs the file to uploadUrl; the Content-Type request header must equal contentType (it is part of the signature).
 * uploaded = true means this attachment was already fully uploaded earlier (a retry), so it need not be uploaded again.
 */
public record AttachmentUploadView(AttachmentView attachment, String uploadUrl, String contentType,
                                   Instant expiresAt, boolean uploaded) {
}
