package com.politeness.ading.ops.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

class OpsAccountGuardTest {

    private static final String SECRET = "a-secret-that-is-definitely-long-enough";

    private static OpsProperties properties(String users, String secret) {
        OpsProperties properties = new OpsProperties();
        properties.setUsers(users);
        properties.setAuthSecret(secret);
        return properties;
    }

    private static OpsAccountGuard guard(String users, String... profiles) {
        return guardWith(users, SECRET, profiles);
    }

    private static OpsAccountGuard guardWith(String users, String secret, String... profiles) {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles(profiles);
        return new OpsAccountGuard(properties(users, secret), environment);
    }

    @Test
    void parsesACommaSeparatedListWithJunkAroundIt() {
        OpsAccountGuard guard = guard(" opsadmin , ,teammate ,");
        assertEquals(2, guard.accountCount());
        assertTrue(guard.isOpsUser("opsadmin"));
        assertTrue(guard.isOpsUser("teammate"));
        assertFalse(guard.isOpsUser("someone-else"));
    }

    @Test
    void matchesUsernamesCaseInsensitivelyLikeTheDatabaseDoes() {
        // users.username is utf8mb4_unicode_ci, so Opsadmin and opsadmin are the same account in the database;
        // if the list comparison were case-sensitive, ops would hit "correct password but can't log in"
        OpsAccountGuard guard = guard("OpsAdmin");
        assertTrue(guard.isOpsUser("opsadmin"));
        assertTrue(guard.isOpsUser("OPSADMIN"));
        assertTrue(guard.isOpsUser("  opsadmin  "));
    }

    @Test
    void rejectsNullAndEmptyUsernames() {
        OpsAccountGuard guard = guard("opsadmin");
        assertFalse(guard.isOpsUser(null));
        assertFalse(guard.isOpsUser(""));
        assertFalse(guard.isOpsUser("   "));
    }

    @Test
    void anEmptyListLocksEverybodyOutInsteadOfLettingEverybodyIn() {
        OpsAccountGuard guard = guard("");
        assertEquals(0, guard.accountCount());
        assertFalse(guard.isOpsUser("opsadmin"));
        assertFalse(guard.isOpsUser(null));
    }

    @Test
    void refusesToStartInProductionWithAMissingOrWeakSecret() {
        // The ops console is publicly reachable; a weak secret means anyone can forge a session, so better not to start
        assertThrows(IllegalStateException.class, () -> guardWith("opsadmin", "", "prod"));
        assertThrows(IllegalStateException.class, () -> guardWith("opsadmin", "too-short", "prod"));
        // pre and prod share the ECS and business database, so both are public-facing environments
        assertThrows(IllegalStateException.class, () -> guardWith("opsadmin", null, "pre"));
    }

    @Test
    void acceptsAConfiguredSecretInProduction() {
        assertEquals(SECRET, guardWith("opsadmin", "  " + SECRET + "  ", "prod").secret(), "Leading and trailing whitespace is trimmed");
    }

    @Test
    void fallsBackToARandomSecretOutsideProductionSoRestartOnlyCostsALogin() {
        OpsAccountGuard first = guardWith("opsadmin", "short", "dev");
        OpsAccountGuard second = guardWith("opsadmin", "", "dev");
        assertEquals(44, first.secret().length(), "32 bytes in standard base64 with padding is 44 characters");
        assertNotEquals(first.secret(), second.secret(), "Each startup gets a new one, so old sessions naturally become invalid");
        assertNotEquals("short", first.secret());
        assertTrue(first.isOpsUser("opsadmin"), "The fallback secret doesn't affect list checks");
    }
}
