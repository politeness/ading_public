package com.politeness.ading.conductor.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import org.junit.jupiter.api.Test;

class IdGeneratorTest {

    private final IdGenerator idGenerator = new IdGenerator();

    @Test
    void ulidHasFixedLength26AndRestrictedCharset() {
        String ulid = idGenerator.ulid();
        assertEquals(26, ulid.length());
        assertTrue(ulid.matches("[0-9A-HJKMNP-TV-Z]{26}"), "Contains characters outside Crockford Base32: " + ulid);
    }

    @Test
    void businessIdHasPrefix() {
        assertTrue(idGenerator.userId().startsWith("u_"));
        assertTrue(idGenerator.terminalId().startsWith("d_"));
        assertTrue(idGenerator.conversationId().startsWith("t_"));
        assertTrue(idGenerator.messageId().startsWith("m_"));
        assertTrue(idGenerator.sessionId().startsWith("s_"));
    }

    @Test
    void manyGeneratedIdsAreUnique() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 50_000; i++) {
            assertTrue(seen.add(idGenerator.ulid()), "ULID #" + i + " is a duplicate");
        }
    }

    @Test
    void sameMillisecondSharesPrefixWithRandomSuffix() {
        String a = idGenerator.ulid();
        String b = idGenerator.ulid();
        assertTrue(a.substring(0, 10).compareTo(b.substring(0, 10)) <= 0, "Timestamp part should be monotonically non-decreasing");
    }
}
