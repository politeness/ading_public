package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.ContentFilter;
import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.MessageMapper;
import com.politeness.ading.conductor.error.MessageError;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;

@Slf4j
@Service
public class MessageService {

    /** An agent's single reply can be very long (full reports or code); the limit must fit it so the online version doesn't reject it */
    static final int MAX_CONTENT_LENGTH = 200_000;
    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 1000;
    private static final Set<String> TYPES = Set.of(
            MessageEntity.TYPE_USER, MessageEntity.TYPE_SYSTEM, MessageEntity.TYPE_TASK, MessageEntity.TYPE_SKILL);

    private final MessageMapper messageMapper;
    private final ConversationUserRelMapper memberMapper;
    private final ConversationService conversationService;
    private final MessageWriter messageWriter;
    private final AttachmentService attachmentService;

    public MessageService(MessageMapper messageMapper,
                          ConversationUserRelMapper memberMapper,
                          ConversationService conversationService,
                          MessageWriter messageWriter,
                          AttachmentService attachmentService) {
        this.messageMapper = messageMapper;
        this.memberMapper = memberMapper;
        this.conversationService = conversationService;
        this.messageWriter = messageWriter;
        this.attachmentService = attachmentService;
    }

    /** Parameters for sending a message. internal, report, failed and extra come from the desktop scheduler and are saved as-is by the backend */
    public record SendCommand(String messageId, String content, String type,
                              List<String> mentions, String replyTo,
                              Boolean internal, Boolean report, Boolean failed, String extra,
                              List<String> attachments) {
    }

    /**
     * Send a message. Humans and agents use the same path — the only difference is whether the caller carries an access token or a node token.
     * No second API for agents, so idempotency, seq allocation and broadcast are written only once.
     */
    public MessageEntity send(String conversationId, String senderId, SendCommand command) {
        String messageId = command.messageId();
        String content = command.content();
        if (messageId == null || messageId.isBlank() || messageId.length() > 64) {
            throw new BizException(MessageError.BAD_MESSAGE_ID);
        }
        boolean hasAttachments = command.attachments() != null && !command.attachments().isEmpty();
        // Text may be omitted when only sending images or files
        if (content == null || (content.isBlank() && !hasAttachments)) {
            throw new BizException(MessageError.CONTENT_BLANK);
        }
        if (content.length() > MAX_CONTENT_LENGTH) {
            throw new BizException(MessageError.CONTENT_TOO_LONG);
        }

        ConversationEntity conversation = conversationService.requireMember(conversationId, senderId);
        // Authorization precedes idempotency, including concurrent retry recovery.
        MessageEntity existing = messageMapper.findByMessageId(messageId);
        if (existing != null) {
            return requireSameRequest(existing, conversationId, senderId);
        }
        conversationService.requireCanSpeak(conversation, senderId);
        requireAppropriate(conversationId, senderId, content);

        String normalizedType = command.type() == null
                ? MessageEntity.TYPE_USER
                : command.type().toUpperCase(Locale.ROOT);
        if (!TYPES.contains(normalizedType)) {
            normalizedType = MessageEntity.TYPE_USER;
        }

        String mentionsColumn = normalizeMentions(conversationId, command.mentions());

        String replyTo = command.replyTo();
        if (replyTo != null && !replyTo.isBlank()) {
            MessageEntity parent = messageMapper.findByMessageId(replyTo);
            if (parent == null || !conversationId.equals(parent.getConversationId())) throw new BizException(MessageError.REPLY_NOT_FOUND);
        }

        AttachmentService.Prepared attachments = attachmentService.prepare(conversationId, senderId, messageId, command.attachments());

        MessageEntity message = new MessageEntity();
        message.setMessageId(messageId);
        message.setConversationId(conversation.getConversationId());
        message.setSenderId(senderId);
        message.setContent(content);
        message.setType(normalizedType);
        message.setMentions(mentionsColumn);
        message.setReplyTo(replyTo == null || replyTo.isBlank() ? null : replyTo);
        message.setStatus(MessageEntity.STATUS_SENT);
        message.setIsDeleted(false);
        message.setInternal(Boolean.TRUE.equals(command.internal()));
        message.setReport(Boolean.TRUE.equals(command.report()));
        message.setFailed(Boolean.TRUE.equals(command.failed()));
        message.setExtra(command.extra());
        message.setAttachments(attachments.json());

        MessageEntity saved;
        try {
            saved = messageWriter.write(message, attachments);
        } catch (DuplicateKeyException e) {
            // Concurrent retries hit the unique key: the transaction rolled back and no seq was consumed, so return the one that arrived first
            MessageEntity concurrent = messageMapper.findByMessageId(messageId);
            if (concurrent != null) {
                return requireSameRequest(concurrent, conversationId, senderId);
            }
            throw e;
        }
        return saved;
    }

    /**
     * Messages from humans to other humans go through the blocked-terms filter (App Store Review Guideline 1.2).
     * Messages to your own Agents aren't filtered: that's assigning work, and blocking would hurt work content. Logs record only the matched term, never the message text.
     */
    public void requireAppropriate(String conversationId, String senderId, String content) {
        if (!conversationService.isSpeakingToPeople(conversationId, senderId)) return;
        String term = ContentFilter.blockedTerm(content);
        if (term == null) return;
        log.info("Message blocked by blocked-terms filter conversationId={} senderId={} term={}", conversationId, senderId, term);
        throw new BizException(MessageError.CONTENT_BLOCKED);
    }

    /** Desktop asks before sending: it writes locally first and queues the upload, so a rejection must be reported to the user at send time */
    public void checkContent(String conversationId, String senderId, String content) {
        conversationService.requireMember(conversationId, senderId);
        requireAppropriate(conversationId, senderId, content);
    }

    private MessageEntity requireSameRequest(MessageEntity message, String conversationId, String senderId) {
        if (!conversationId.equals(message.getConversationId()) || !senderId.equals(message.getSenderId())) {
            throw new BizException(MessageError.BAD_MESSAGE_ID);
        }
        return message;
    }

    public void markDelivered(String conversationId, String userId, long seq) {
        ConversationEntity conversation = conversationService.requireMember(conversationId, userId);
        memberMapper.advanceDeliveredSeq(conversationId, userId, Math.max(0, Math.min(seq, conversation.getLastSeq())));
    }

    public List<MessageEntity> fetch(String conversationId, String userId,
                                     Long afterSeq, Long beforeSeq, Integer limit) {
        conversationService.requireAccessible(conversationId, userId);
        int size = limit == null ? DEFAULT_LIMIT : Math.min(Math.max(limit, 1), MAX_LIMIT);

        if (afterSeq != null) {
            return messageMapper.listAfterSeq(conversationId, afterSeq, size);
        }
        if (beforeSeq != null) {
            List<MessageEntity> messages = messageMapper.listBeforeSeq(conversationId, beforeSeq, size);
            Collections.reverse(messages);
            return messages;
        }
        List<MessageEntity> latest = messageMapper.listLatest(conversationId, size);
        Collections.reverse(latest);
        return latest;
    }

    public MessageEntity latest(String conversationId) {
        return messageMapper.findLatest(conversationId);
    }

    public void markRead(String conversationId, String userId, long seq) {
        ConversationEntity conversation = conversationService.requireAccessible(conversationId, userId);
        if (conversationService.isSharedView(conversationId, userId)) return;
        int advanced = memberMapper.advanceReadSeq(conversationId, userId, Math.max(0, Math.min(seq, conversation.getLastSeq())));
        memberMapper.refreshFirstUnreadMention(conversationId, userId);
        // All terminals of the same account share the watermark; duplicate or out-of-order receipts don't trigger another broadcast.
        if (advanced > 0) conversationService.notifyConversationUpdated(conversationId);
    }

    /** An Agent's processing watermark: only increases, never above the conversation's current max seq */
    public void markProcessed(String conversationId, String agentUserId, long seq) {
        ConversationEntity conversation = conversationService.requireMember(conversationId, agentUserId);
        memberMapper.advanceProcessedSeq(conversationId, agentUserId, Math.max(0, Math.min(seq, conversation.getLastSeq())));
    }

    private String normalizeMentions(String conversationId, List<String> mentions) {
        if (mentions == null || mentions.isEmpty()) {
            return null;
        }
        Set<String> memberIds = new LinkedHashSet<>(conversationService.memberIds(conversationId));
        List<String> valid = new ArrayList<>();
        for (String mention : new LinkedHashSet<>(mentions)) {
            if (!memberIds.contains(mention)) {
                throw new BizException(MessageError.BAD_MENTION, "Not in the conversation: " + mention);
            }
            valid.add(mention);
        }
        return String.join(",", valid);
    }
}
