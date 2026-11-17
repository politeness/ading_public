package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.dal.AttachmentRow;
import com.politeness.ading.ops.service.AttachmentStore;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Set;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;

/** Writes an attachment to the caller. Attachment content comes from users, so only these few image types are shown inline; everything else is served as a download so it can't execute as a page under the ops console domain. */
@Component
class AttachmentResponses {

    private static final Set<String> INLINE_TYPES = Set.of("image/png", "image/jpeg", "image/webp");

    private final AttachmentStore store;

    AttachmentResponses(AttachmentStore store) {
        this.store = store;
    }

    void write(AttachmentRow row, HttpServletResponse response) throws IOException {
        String type = row.getContentType() == null ? "" : row.getContentType().trim().toLowerCase(Locale.ROOT);
        boolean inline = INLINE_TYPES.contains(type);
        response.setContentType(inline ? type : "application/octet-stream");
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader(HttpHeaders.CONTENT_DISPOSITION,
                (inline ? ContentDisposition.inline() : ContentDisposition.attachment())
                        .filename(row.getName(), StandardCharsets.UTF_8).build().toString());
        store.copyTo(row.getObjectKey(), response.getOutputStream());
    }
}
