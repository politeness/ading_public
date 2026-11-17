package com.politeness.ading.conductor.common;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PasswordEncoderTest {

    private final PasswordEncoder encoder = new PasswordEncoder();

    @Test
    void correctPasswordPassesVerification() {
        String hash = encoder.encode("correct horse battery");
        assertTrue(encoder.matches("correct horse battery", hash));
    }

    @Test
    void wrongPasswordFails() {
        String hash = encoder.encode("correct horse battery");
        assertFalse(encoder.matches("wrong horse battery", hash));
    }

    @Test
    void samePasswordHashedTwiceUsesDifferentSalts() {
        assertNotEquals(encoder.encode("same"), encoder.encode("same"));
    }

    @Test
    void malformedHashReturnsFalseWithoutThrowing() {
        assertFalse(encoder.matches("x", "not-a-hash"));
        assertFalse(encoder.matches("x", null));
        assertFalse(encoder.matches(null, encoder.encode("x")));
    }
}
