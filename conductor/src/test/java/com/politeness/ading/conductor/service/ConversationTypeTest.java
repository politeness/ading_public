package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import org.junit.jupiter.api.Test;

/**
 * This pins down the model itself, not a particular function:
 * a conversation's granularity is "one matter", so there can be any number of conversations with the same person.
 * Old versions made direct chats idempotent by a member-pair fingerprint; that field has been removed, and this test keeps it from coming back.
 */
class ConversationTypeTest {

    @Test
    void directAndGroupChatOnlyDescribeMemberCount() {
        assertEquals("DIRECT", ConversationEntity.TYPE_DIRECT);
        assertEquals("GROUP", ConversationEntity.TYPE_GROUP);
        assertNotEquals(ConversationEntity.TYPE_DIRECT, ConversationEntity.TYPE_GROUP);
    }

    @Test
    void conversationEntityNoLongerHasMemberPairFingerprintField() throws Exception {
        for (var field : ConversationEntity.class.getDeclaredFields()) {
            assertNotEquals("memberKey", field.getName(),
                    "Reintroducing memberKey would bring back direct-chat idempotency and push \"one conversation per matter\" back to the chat-window model");
        }
    }
}
