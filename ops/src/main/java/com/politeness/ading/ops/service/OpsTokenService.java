package com.politeness.ading.ops.service;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.config.OpsAccountGuard;
import com.politeness.ading.ops.config.OpsProperties;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.Base64;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * Ops session token: a hand-written HMAC-SHA256 JWT using only the JDK and Jackson, with no third-party JWT library.
 *
 * Payload: sub (user_id), usr (username), tep (users.token_epoch at issue time), exp (expiry seconds).
 *
 * Signed with OpsAccountGuard's secret, a different key from conductor's ADING_AUTH_SECRET,
 * so access tokens held by ADing clients never verify on the ops console, and vice versa.
 * tep makes "changing the password kicks out all ops sessions" hold: on password change conductor increments the epoch,
 * and here it is compared with the database epoch; tokens with a smaller epoch are rejected outright.
 */
@Component
public class OpsTokenService {

    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();
    private static final String HEADER = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";

    private final OpsAccountGuard guard;
    private final OpsProperties properties;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    @Autowired
    public OpsTokenService(OpsAccountGuard guard, OpsProperties properties, ObjectMapper objectMapper) {
        this(guard, properties, objectMapper, Clock.system(properties.zoneId()));
    }

    OpsTokenService(OpsAccountGuard guard, OpsProperties properties, ObjectMapper objectMapper, Clock clock) {
        this.guard = guard;
        this.properties = properties;
        this.objectMapper = objectMapper;
        this.clock = clock;
    }

    public String issue(String userId, String username, int epoch) {
        long expiresAt = nowSeconds() + properties.getSessionTtlSeconds();
        String body = write(Map.of(
                "sub", userId,
                "usr", username,
                "tep", epoch,
                "exp", expiresAt));
        String head = ENCODER.encodeToString(HEADER.getBytes(StandardCharsets.UTF_8));
        String claims = ENCODER.encodeToString(body.getBytes(StandardCharsets.UTF_8));
        String signingInput = head + "." + claims;
        return signingInput + "." + ENCODER.encodeToString(sign(signingInput));
    }

    public LocalDateTime expiresAt() {
        // Truncate to seconds: the exp in the token is in seconds anyway, and the expiry returned in both places must look identical
        return LocalDateTime.now(clock).truncatedTo(ChronoUnit.SECONDS)
                .plusSeconds(properties.getSessionTtlSeconds());
    }

    public ZoneId zone() {
        return clock.getZone();
    }

    /** Verifies signature and expiry and returns the payload. Any problem throws NOT_LOGIN; never returns null. */
    public Claims parse(String token) {
        if (token == null || token.isBlank()) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        byte[] expected = sign(parts[0] + "." + parts[1]);
        byte[] actual;
        Map<String, Object> payload;
        try {
            actual = DECODER.decode(parts[2]);
        } catch (IllegalArgumentException e) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        if (!constantTimeEquals(expected, actual)) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        try {
            payload = objectMapper.readValue(DECODER.decode(parts[1]), Map.class);
        } catch (Exception e) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        if (!(payload.get("exp") instanceof Number exp) || exp.longValue() < nowSeconds()) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        if (!(payload.get("sub") instanceof String userId) || userId.isBlank()) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        if (!(payload.get("usr") instanceof String username) || username.isBlank()) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
        int epoch = payload.get("tep") instanceof Number tep ? tep.intValue() : 0;
        LocalDateTime expiresAt = LocalDateTime.ofInstant(
                Instant.ofEpochSecond(exp.longValue()), clock.getZone());
        return new Claims(userId, username, epoch, expiresAt);
    }

    /** The token's account must still be on the ops list now; once someone is removed from the list, their tokens are invalid immediately */
    public void requireStillOps(Claims claims) {
        if (!guard.isOpsUser(claims.username())) {
            throw new BizException(OpsError.NOT_LOGIN);
        }
    }

    private long nowSeconds() {
        return clock.millis() / 1000L;
    }

    private String write(Map<String, Object> payload) {
        try {
            return objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException("Token serialization failed", e);
        }
    }

    private byte[] sign(String signingInput) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(guard.secret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException("Token signing failed", e);
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

    public record Claims(String userId, String username, int epoch, LocalDateTime expiresAt) {
    }
}
