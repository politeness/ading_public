package com.politeness.ading.conductor.service;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.MessageMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import java.util.List;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

class MessageWriterPushTest {
    private final PushNotificationService pushes = mock(PushNotificationService.class);

    @AfterEach void clear() {
        TransactionSynchronizationManager.clear();
    }

    private MessageEntity write() {
        var conversations = mock(ConversationMapper.class);
        when(conversations.bumpSeq("c")).thenReturn(1);
        when(conversations.selectLastSeq("c")).thenReturn(3L);
        var members = mock(ConversationUserRelMapper.class);
        when(members.listViewerIds("c")).thenReturn(List.of("u"));
        var writer = new MessageWriter(conversations, mock(MessageMapper.class), members, mock(NodeRegistry.class),
                mock(AttachmentService.class), pushes);
        var message = new MessageEntity();
        message.setMessageId("m");
        message.setConversationId("c");
        message.setSenderId("u");
        return writer.write(message, null);
    }

    @Test void pushesOnlyAfterCommit() {
        TransactionSynchronizationManager.initSynchronization();
        var message = write();
        verify(pushes, never()).messageSaved(any());
        for (TransactionSynchronization sync : TransactionSynchronizationManager.getSynchronizations()) sync.afterCommit();
        verify(pushes).messageSaved(message);
    }

    @Test void rolledBackMessageIsNotPushed() {
        TransactionSynchronizationManager.initSynchronization();
        write();
        for (TransactionSynchronization sync : TransactionSynchronizationManager.getSynchronizations()) {
            sync.afterCompletion(TransactionSynchronization.STATUS_ROLLED_BACK);
        }
        verify(pushes, never()).messageSaved(any());
    }
}
