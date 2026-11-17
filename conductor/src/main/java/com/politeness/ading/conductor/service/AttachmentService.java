package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.AttachmentCreateRequest;
import com.politeness.ading.conductor.controller.dto.AttachmentUploadView;
import com.politeness.ading.conductor.controller.dto.AttachmentUrlView;
import com.politeness.ading.conductor.controller.dto.AttachmentView;
import com.politeness.ading.conductor.dal.entity.AttachmentEntity;
import com.politeness.ading.conductor.dal.mapper.AttachmentMapper;
import com.politeness.ading.conductor.error.AttachmentError;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.OptionalLong;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * Message attachments: registration, upload and download URLs, and validation plus binding when sending a message.
 *
 * <p>Files never pass through the backend: phones and computers upload/download directly with OSS via signed URLs; the backend only decides "who can upload, who can view".
 * Viewers are conversation members — the same people who can see the message.
 */
@Service
public class AttachmentService {

    private static final Pattern ATTACHMENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final String DEFAULT_MIME = "application/octet-stream";

    private final AttachmentMapper attachmentMapper;
    private final AttachmentStorage storage;
    private final ConversationService conversationService;
    private final AdingProperties.Attachment settings;
    private final ObjectMapper objectMapper;

    public AttachmentService(AttachmentMapper attachmentMapper,
                             AttachmentStorage storage,
                             ConversationService conversationService,
                             AdingProperties properties,
                             ObjectMapper objectMapper) {
        this.attachmentMapper = attachmentMapper;
        this.storage = storage;
        this.conversationService = conversationService;
        this.settings = properties.getAttachment();
        this.objectMapper = objectMapper;
    }

    /** Register and return an upload URL. Re-registering the same ID (retry) returns a new upload URL without creating a duplicate record */
    public AttachmentUploadView register(String conversationId, String uploaderId, AttachmentCreateRequest request) {
        conversationService.requireMember(conversationId, uploaderId);
        String attachmentId = request.attachmentId();
        if (!ATTACHMENT_ID.matcher(attachmentId).matches()) throw new BizException(AttachmentError.BAD_ID);
        String name = cleanName(request.name());
        if (request.size() > settings.getMaxBytes()) throw new BizException(AttachmentError.TOO_LARGE);
        String mimeType = cleanMime(request.mimeType());

        AttachmentEntity attachment = attachmentMapper.findByAttachmentId(attachmentId);
        if (attachment != null) {
            if (!conversationId.equals(attachment.getConversationId()) || !uploaderId.equals(attachment.getUploaderId())) {
                throw new BizException(AttachmentError.BAD_ID);
            }
        } else {
            attachment = new AttachmentEntity();
            attachment.setAttachmentId(attachmentId);
            attachment.setConversationId(conversationId);
            attachment.setUploaderId(uploaderId);
            attachment.setName(name);
            attachment.setMimeType(mimeType);
            attachment.setSizeBytes(request.size());
            attachment.setKind(kindOf(mimeType));
            attachment.setObjectKey(objectKey(uploaderId, attachment.getKind(), attachmentId, name));
            attachment.setStatus(AttachmentEntity.STATUS_PENDING);
            attachmentMapper.insert(attachment);
        }
        boolean uploaded = AttachmentEntity.STATUS_READY.equals(attachment.getStatus());
        AttachmentStorage.SignedUrl upload = storage.uploadUrl(attachment.getObjectKey(), attachment.getMimeType());
        return new AttachmentUploadView(AttachmentView.from(attachment), upload.url(),
                attachment.getMimeType(), upload.expiresAt(), uploaded);
    }

    public AttachmentUrlView downloadUrl(String conversationId, String userId, String attachmentId) {
        conversationService.requireAccessible(conversationId, userId);
        AttachmentEntity attachment = attachmentMapper.findByAttachmentId(attachmentId);
        if (attachment == null || !conversationId.equals(attachment.getConversationId())) {
            throw new BizException(AttachmentError.NOT_FOUND);
        }
        AttachmentStorage.SignedUrl download = storage.downloadUrl(attachment.getObjectKey(), attachment.getName());
        return new AttachmentUrlView(download.url(), download.expiresAt());
    }

    /**
     * Validation before sending: the attachment belongs to this conversation, was registered by the sender, is fully uploaded, and isn't used in another message.
     * Returns the attachment list as JSON (written to messages.attachments); null when there are no attachments.
     */
    public Prepared prepare(String conversationId, String senderId, String messageId, List<String> attachmentIds) {
        if (attachmentIds == null || attachmentIds.isEmpty()) return new Prepared(List.of(), List.of(), null);
        List<String> ids = new ArrayList<>(new LinkedHashSet<>(attachmentIds));
        if (ids.size() > settings.getMaxPerMessage()) throw new BizException(AttachmentError.TOO_MANY);
        List<AttachmentEntity> entities = new ArrayList<>();
        List<AttachmentView> views = new ArrayList<>();
        for (String id : ids) {
            AttachmentEntity attachment = id == null ? null : attachmentMapper.findByAttachmentId(id);
            if (attachment == null || !conversationId.equals(attachment.getConversationId())
                    || !senderId.equals(attachment.getUploaderId())) {
                throw new BizException(AttachmentError.NOT_FOUND, "Attachment not found: " + id);
            }
            if (attachment.getMessageId() != null && !attachment.getMessageId().equals(messageId)) {
                throw new BizException(AttachmentError.ALREADY_SENT);
            }
            OptionalLong size = storage.size(attachment.getObjectKey());
            if (size.isEmpty()) throw new BizException(AttachmentError.NOT_UPLOADED, "Attachment upload not finished: " + attachment.getName());
            if (size.getAsLong() > settings.getMaxBytes()) throw new BizException(AttachmentError.TOO_LARGE);
            // The actual size on OSS wins; the size reported at registration may be inaccurate
            attachment.setSizeBytes(size.getAsLong());
            entities.add(attachment);
            views.add(AttachmentView.from(attachment));
        }
        return new Prepared(entities, views, objectMapper.writeValueAsString(views));
    }

    /** Bind attachments to the message after it is persisted */
    public void bind(Prepared prepared, String messageId) {
        for (AttachmentEntity attachment : prepared.entities()) {
            attachmentMapper.markSent(attachment.getAttachmentId(), messageId, attachment.getSizeBytes());
        }
    }

    public record Prepared(List<AttachmentEntity> entities, List<AttachmentView> views, String json) {
        public boolean isEmpty() {
            return entities.isEmpty();
        }
    }

    static String kindOf(String mimeType) {
        if (mimeType.startsWith("image/")) return AttachmentEntity.KIND_IMAGE;
        if (mimeType.startsWith("video/")) return AttachmentEntity.KIND_VIDEO;
        return AttachmentEntity.KIND_FILE;
    }

    private static String cleanName(String name) {
        String cleaned = name == null ? "" : name.replaceAll("[\\p{Cntrl}/\\\\]", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) throw new BizException(AttachmentError.BAD_NAME);
        return cleaned;
    }

    private static String cleanMime(String mimeType) {
        if (mimeType == null || mimeType.isBlank()) return DEFAULT_MIME;
        String lower = mimeType.trim().toLowerCase(Locale.ROOT);
        return lower.matches("[a-z0-9.+-]+/[a-z0-9.+-]+") ? lower : DEFAULT_MIME;
    }

    /**
     * Stored on OSS by uploading account, then by type: attachments/<userId>/image|video|file/<attachment ID>.<extension>.
     * Object names are ASCII only: only the extension of the original file name is kept; the display name is in the database.
     */
    private String objectKey(String uploaderId, String kind, String attachmentId, String name) {
        int dot = name.lastIndexOf('.');
        String extension = dot > 0 ? name.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
        String suffix = extension.matches("[a-z0-9]{1,10}") ? "." + extension : "";
        return settings.getOssKeyPrefix() + "/" + uploaderId + "/" + kind.toLowerCase(Locale.ROOT) + "/" + attachmentId + suffix;
    }
}
