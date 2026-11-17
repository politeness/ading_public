package com.politeness.ading.conductor.controller.dto;

import com.fasterxml.jackson.annotation.JsonRawValue;
import com.politeness.ading.conductor.common.Times;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import java.time.Instant;
import java.util.Arrays;
import java.util.List;

public record MessageView(
        String messageId,
        String conversationId,
        long seq,
        String senderId,
        String content,
        String type,
        List<String> mentions,
        String replyTo,
        String status,
        Instant gmtCreated,
        boolean internal,
        boolean report,
        boolean failed,
        /** Extra info from the desktop scheduler; whatever JSON was stored is returned as is */
        @JsonRawValue String extra,
        /** Attachments (AttachmentView array); download URLs are fetched separately */
        @JsonRawValue String attachments) {

    public static MessageView from(MessageEntity message) {
        if (message == null) {
            return null;
        }
        List<String> mentions = (message.getMentions() == null || message.getMentions().isBlank())
                ? List.of()
                : Arrays.asList(message.getMentions().split(","));
        return new MessageView(
                message.getMessageId(),
                message.getConversationId(),
                message.getSeq() == null ? 0L : message.getSeq(),
                message.getSenderId(),
                message.getContent(),
                message.getType(),
                mentions,
                message.getReplyTo(),
                message.getStatus(),
                Times.instant(message.getGmtCreated()),
                Boolean.TRUE.equals(message.getInternal()),
                Boolean.TRUE.equals(message.getReport()),
                Boolean.TRUE.equals(message.getFailed()),
                message.getExtra(),
                message.getAttachments());
    }
}
