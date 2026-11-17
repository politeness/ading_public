package com.politeness.ading.conductor.controller.dto;

import com.politeness.ading.conductor.dal.entity.AttachmentEntity;

/** An attachment carried by a message: stored in messages.attachments and returned to the client as is. Download URLs are fetched separately on demand and not stored. */
public record AttachmentView(String attachmentId, String name, String mimeType, long size, String kind) {

    public static AttachmentView from(AttachmentEntity attachment) {
        return new AttachmentView(
                attachment.getAttachmentId(),
                attachment.getName(),
                attachment.getMimeType(),
                attachment.getSizeBytes() == null ? 0L : attachment.getSizeBytes(),
                attachment.getKind());
    }
}
