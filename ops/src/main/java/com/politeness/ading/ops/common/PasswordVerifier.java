package com.politeness.ading.ops.common;

import java.security.SecureRandom;
import java.util.Base64;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.PBEKeySpec;
import org.springframework.stereotype.Component;

/**
 * Verifies ADing account password hashes.
 *
 * The storage format must match conductor's PasswordEncoder exactly (pbkdf2$iterations$base64(salt)$base64(hash),
 * PBKDF2-HMAC-SHA256, 256-bit key), otherwise the ops console can't recognise ADing passwords. Iterations are read from the hash,
 * so if conductor raises the iteration count later, old hashes still verify.
 *
 * Verification only, no generation: the ops console has no sign-up or password-change feature, and shouldn't.
 * This implementation is deliberately copied rather than depending on conductor's jar - the ops package must build and deploy independently.
 *
 * Whether or not the given hash exists or is valid, matches runs exactly one full PBKDF2:
 * when there is no hash to compare against, it computes a random decoy hash. Otherwise "account missing / not on the list" would be hundreds of ms faster than "wrong password",
 * and timing responses over the public internet would enumerate ops accounts.
 */
@Component
public class PasswordVerifier {

    private static final String ALGORITHM = "PBKDF2WithHmacSHA256";
    private static final int KEY_LENGTH = 256;
    /** Iteration count of the decoy hash; kept equal to conductor PasswordEncoder's ITERATIONS so the timing matches */
    static final int DECOY_ITERATIONS = 120_000;

    private final byte[] decoySalt = randomBytes(16);
    private final byte[] decoyHash = randomBytes(KEY_LENGTH / 8);

    /** When encoded is empty or malformed, still compute the decoy once before returning false; see the class comment */
    public boolean matches(String rawPassword, String encoded) {
        String raw = rawPassword == null ? "" : rawPassword;
        Parsed parsed = parse(encoded);
        if (rawPassword == null || parsed == null) {
            constantTimeEquals(decoyHash, pbkdf2(raw, decoySalt, DECOY_ITERATIONS));
            return false;
        }
        return constantTimeEquals(parsed.expected(), pbkdf2(raw, parsed.salt(), parsed.iterations()));
    }

    private record Parsed(int iterations, byte[] salt, byte[] expected) {
    }

    private static Parsed parse(String encoded) {
        if (encoded == null) {
            return null;
        }
        String[] parts = encoded.split("\\$");
        if (parts.length != 4 || !"pbkdf2".equals(parts[0])) {
            return null;
        }
        int iterations;
        try {
            iterations = Integer.parseInt(parts[1]);
        } catch (NumberFormatException e) {
            return null;
        }
        if (iterations <= 0) {
            return null;
        }
        try {
            return new Parsed(iterations,
                    Base64.getDecoder().decode(parts[2]), Base64.getDecoder().decode(parts[3]));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private static byte[] randomBytes(int length) {
        byte[] bytes = new byte[length];
        new SecureRandom().nextBytes(bytes);
        return bytes;
    }

    private byte[] pbkdf2(String password, byte[] salt, int iterations) {
        try {
            PBEKeySpec spec = new PBEKeySpec(password.toCharArray(), salt, iterations, KEY_LENGTH);
            return SecretKeyFactory.getInstance(ALGORITHM).generateSecret(spec).getEncoded();
        } catch (Exception e) {
            throw new IllegalStateException("Password hash computation failed", e);
        }
    }

    private boolean constantTimeEquals(byte[] a, byte[] b) {
        if (a.length != b.length) {
            return false;
        }
        int diff = 0;
        for (int i = 0; i < a.length; i++) {
            diff |= a[i] ^ b[i];
        }
        return diff == 0;
    }
}
