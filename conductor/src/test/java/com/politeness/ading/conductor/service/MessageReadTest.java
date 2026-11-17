package com.politeness.ading.conductor.service;

import static org.mockito.Mockito.*;
import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.MessageMapper;
import org.junit.jupiter.api.Test;

class MessageReadTest {
    @Test void broadcastsOnlyAdvancedReadsAndClampsToConversation() {
        var members = mock(ConversationUserRelMapper.class);
        var conversations = mock(ConversationService.class);
        var conversation = new ConversationEntity();
        conversation.setLastSeq(8L);
        when(conversations.requireAccessible("c", "u")).thenReturn(conversation);
        when(members.advanceReadSeq("c", "u", 8)).thenReturn(1, 0);
        var service = new MessageService(mock(MessageMapper.class), members, conversations,
                mock(MessageWriter.class), mock(AttachmentService.class));
        service.markRead("c", "u", 99);
        service.markRead("c", "u", 8);
        service.markRead("c", "u", -1);
        verify(members, times(2)).advanceReadSeq("c", "u", 8);
        verify(members).advanceReadSeq("c", "u", 0);
        verify(members, times(3)).refreshFirstUnreadMention("c", "u");
        verify(conversations, times(1)).notifyConversationUpdated("c");
        clearInvocations(members, conversations);
        when(conversations.isSharedView("c", "u")).thenReturn(true);
        service.markRead("c", "u", 8);
        verifyNoInteractions(members);
        verify(conversations, never()).notifyConversationUpdated("c");
    }
}
