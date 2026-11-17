package com.politeness.ading.ops.config;

import java.security.SecureRandom;
import java.util.Base64;
import java.util.Locale;
import java.util.Set;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * Parsing and startup validation of the ops account list and the signing secret.
 *
 * The list comes from ADING_OPS_USERS and stores lowercase usernames; both sides are lowercased when comparing,
 * consistent with the users table's utf8mb4_unicode_ci (case-insensitive), so configuring Opsadmin doesn't lock that user out.
 *
 * Validation lives in the constructor, so a misconfigured secret stops startup outright - the ops console is on the public internet,
 * and signing with an empty or hard-coded default secret means anyone can forge a session.
 */
@Slf4j
@Component
public class OpsAccountGuard {

    private static final int MIN_SECRET_LENGTH = 32;

    private final Set<String> opsUsers;
    private final String secret;

    public OpsAccountGuard(OpsProperties properties, Environment environment) {
        this.opsUsers = parse(properties.getUsers());
        this.secret = resolveSecret(properties.getAuthSecret(), isProduction(environment));
        if (opsUsers.isEmpty()) {
            log.warn("ADING_OPS_USERS is empty; nobody can log in to the ops console");
        } else {
            log.info("Ops account list: {} entries", opsUsers.size());
        }
    }

    public boolean isOpsUser(String username) {
        return username != null && opsUsers.contains(username.trim().toLowerCase(Locale.ROOT));
    }

    public String secret() {
        return secret;
    }

    public int accountCount() {
        return opsUsers.size();
    }

    private static String resolveSecret(String configured, boolean production) {
        if (configured != null && configured.trim().length() >= MIN_SECRET_LENGTH) {
            return configured.trim();
        }
        if (production) {
            throw new IllegalStateException(
                    "ADING_OPS_AUTH_SECRET is not configured or shorter than " + MIN_SECRET_LENGTH + " bytes; refusing to start the ops console");
        }
        byte[] random = new byte[MIN_SECRET_LENGTH];
        new SecureRandom().nextBytes(random);
        // In development a random secret fills in; the only cost is logging in again after restart, which is safer than leaving a default that could leak into production
        log.warn("ADING_OPS_AUTH_SECRET is not configured; starting with a random secret, all ops sessions become invalid after restart");
        return Base64.getEncoder().encodeToString(random);
    }

    /**
     * Only an explicit dev profile is relaxed; everything else is treated as production: only prod is deployed,
     * and if another profile name shows up one day it won't silently fall back to a random secret.
     */
    private static boolean isProduction(Environment environment) {
        return Stream.of(environment.getActiveProfiles()).noneMatch(profile -> profile.equalsIgnoreCase("dev"));
    }

    private static Set<String> parse(String raw) {
        if (raw == null || raw.isBlank()) {
            return Set.of();
        }
        return Stream.of(raw.split(","))
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .map(value -> value.toLowerCase(Locale.ROOT))
                .collect(Collectors.toUnmodifiableSet());
    }
}
