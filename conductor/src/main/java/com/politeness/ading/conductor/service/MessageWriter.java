package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.MessageMapper;
import com.politeness.ading.conductor.error.MessageError;
import org.springframework.stereotype.Component;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import com.politeness.ading.conductor.manager.NodeFrame;
import com.politeness.ading.conductor.manager.FrameType;
import java.util.Map;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

/**
 * Transaction boundary for persisting messages; it is a separate Bean so MessageService can catch duplicate keys outside the transaction.
 *
 * seq allocation increments under the row lock on conversations.last_seq:
 *   UPDATE conversations SET last_seq = last_seq + 1 WHERE conversation_id = ?
 * the row lock only contends within one conversation, and group chats need serialization anyway — constraint and performance line up,
 * and it saves the extra dependency on Redis (numbers never drift after crash recovery either).
 *
 * If the insert fails, the whole transaction rolls back, including the last_seq increment.
 * So seq is guaranteed gap-free, which lets clients use "seq == local max + 1" to detect lost packets.
 */
@Component
public class MessageWriter {

    private final ConversationMapper conversationMapper;
    private final MessageMapper messageMapper;
    private final ConversationUserRelMapper members;
    private final NodeRegistry nodes;
    private final AttachmentService attachmentService;
    private final PushNotificationService pushes;

    public MessageWriter(ConversationMapper conversationMapper, MessageMapper messageMapper,
                         ConversationUserRelMapper members, NodeRegistry nodes, AttachmentService attachmentService,
                         PushNotificationService pushes) {
        this.conversationMapper = conversationMapper;
        this.messageMapper = messageMapper;
        this.members = members;
        this.nodes = nodes;
        this.attachmentService = attachmentService;
        this.pushes = pushes;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public MessageEntity write(MessageEntity message, AttachmentService.Prepared attachments) {
        int bumped = conversationMapper.bumpSeq(message.getConversationId());
        if (bumped == 0) {
            throw new BizException(MessageError.SEQ_CONFLICT);
        }
        Long seq = conversationMapper.selectLastSeq(message.getConversationId());
        if (seq == null) {
            throw new BizException(MessageError.SEQ_CONFLICT);
        }
        message.setSeq(seq);
        messageMapper.insert(message);
        conversationMapper.touch(message.getConversationId());
        if (message.getMentions() != null && !Boolean.TRUE.equals(message.getInternal())) {
            members.markMentioned(message.getConversationId(), message.getSenderId(), message.getMentions(), seq);
        }
        // Attachments must be ready before a different instance can observe the notification.
        attachmentService.bind(attachments, message.getMessageId());
        // Resolved inside the transaction but published only after commit (TerminalNodeRegistry), so no other
        // instance is told about a message it cannot read yet. Only identifiers go over the wire; fetching content
        // always rechecks membership.
        nodes.broadcast(members.listViewerIds(message.getConversationId()),
                NodeFrame.of(FrameType.MESSAGE_NEW, Map.of("conversationId", message.getConversationId(),
                        "messageId", message.getMessageId(), "seq", seq)));
        // Mobile system notifications are also sent only after commit: rolled-back messages aren't notified
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override public void afterCommit() { pushes.messageSaved(message); }
            });
        } else {
            pushes.messageSaved(message);
        }
        return message;
    }
}
