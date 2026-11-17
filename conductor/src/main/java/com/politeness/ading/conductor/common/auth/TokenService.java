package com.politeness.ading.conductor.common.auth;

import tools.jackson.databind.ObjectMapper;
import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.error.AuthError;
import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.stereotype.Component;

/**
 * Hand-written HMAC-SHA256 JWT. Uses only the JDK and Jackson, no third-party JWT library
 * - only issuing and verifying are needed here, and fewer dependencies are easier to debug.
 *
 * Payload fields:
 *   sub  subject user_id
 *   typ  ACCESS / REFRESH / NODE
 *   terminalId  terminal_id, only in NODE tokens
 *   tep  the account's token epoch at issue time (users.token_epoch)
 *   exp  expiry time (seconds)
 *
 * Tokens are stateless and the server does not store issued tokens, so "invalidate old tokens after a password change" can only rely on the epoch:
 * a password change increments the epoch in the database, and tokens whose payload epoch is lower than the database's are all rejected. The check sits at the auth entry points
 * (AuthInterceptor, token refresh) - refresh tokens last 30 days and
 * computer tokens one year, so just waiting for expiry would let tokens in other people's hands keep working for a year after a password change.
 */
@Component
public class TokenService {

    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
    private static final Base64.Decoder DECODER = Base64.getUrlDecoder();
    private static final String HEADER = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";

    private final AdingProperties properties;
    private final ObjectMapper objectMapper;

    public TokenService(AdingProperties properties, ObjectMapper objectMapper) {
        String secret = properties.getAuth().getSecret();
        if (secret == null || secret.isBlank() || secret.getBytes(StandardCharsets.UTF_8).length < 32
                || "change-me-in-production-at-least-32-bytes-long".equals(secret)) {
            throw new IllegalStateException("ADING_AUTH_SECRET must be a unique random secret of at least 32 bytes");
        }
        this.properties = properties;
        this.objectMapper = objectMapper;
    }

    public String issueAccessToken(String userId, int epoch) {
        return issue(userId, TokenType.ACCESS, null, epoch, properties.getAuth().getAccessTokenTtlSeconds());
    }

    public String issueRefreshToken(String userId, int epoch) {
        return issue(userId, TokenType.REFRESH, null, epoch, properties.getAuth().getRefreshTokenTtlSeconds());
    }

    public String issueNodeToken(String ownerUserId, String terminalId, int epoch) {
        return issue(ownerUserId, TokenType.NODE, terminalId, epoch, properties.getAuth().getNodeTokenTtlSeconds());
    }

    private String issue(String subject, TokenType type, String terminalId, int epoch, long ttlSeconds) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("sub", subject);
        payload.put("typ", type.name());
        if (terminalId != null) {
            payload.put("terminalId", terminalId);
        }
        payload.put("tep", epoch);
        payload.put("exp", System.currentTimeMillis() / 1000L + ttlSeconds);

        String body;
        try {
            body = objectMapper.writeValueAsString(payload);
        } catch (Exception e) {
            throw new IllegalStateException("Token serialization failed", e);
        }
        String head = ENCODER.encodeToString(HEADER.getBytes(StandardCharsets.UTF_8));
        String claims = ENCODER.encodeToString(body.getBytes(StandardCharsets.UTF_8));
        String signingInput = head + "." + claims;
        return signingInput + "." + ENCODER.encodeToString(sign(signingInput));
    }

    /** Verifies the signature and expiry and returns the payload. Any problem throws BizException; never returns null. */
    public Claims parse(String token) {
        if (token == null || token.isBlank()) {
            throw new BizException(AuthError.TOKEN_MISSING);
        }
        String[] parts = token.split("\\.");
        if (parts.length != 3) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        String signingInput = parts[0] + "." + parts[1];
        byte[] expected = sign(signingInput);
        byte[] actual;
        try {
            actual = DECODER.decode(parts[2]);
        } catch (IllegalArgumentException e) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        if (!constantTimeEquals(expected, actual)) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }

        Map<String, Object> payload;
        try {
            payload = objectMapper.readValue(DECODER.decode(parts[1]), Map.class);
        } catch (Exception e) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        Object exp = payload.get("exp");
        if (!(exp instanceof Number expNumber)) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        if (expNumber.longValue() < System.currentTimeMillis() / 1000L) {
            throw new BizException(AuthError.TOKEN_EXPIRED);
        }
        Object sub = payload.get("sub");
        Object typ = payload.get("typ");
        if (sub == null || typ == null) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        TokenType type;
        try {
            type = TokenType.valueOf(typ.toString());
        } catch (IllegalArgumentException e) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        Object terminal = payload.get("terminalId");
        if (type == TokenType.NODE && (!(terminal instanceof String id) || id.isBlank())) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        // A missing tep is treated as 0: tokens issued before this field was added have an epoch equal to a new account's initial value
        Object tep = payload.get("tep");
        int epoch = tep instanceof Number epochNumber ? epochNumber.intValue() : 0;
        return new Claims(sub.toString(), type, terminal == null ? null : terminal.toString(), epoch);
    }

    private byte[] sign(String signingInput) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(
                    properties.getAuth().getSecret().getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
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

    public record Claims(String subject, TokenType type, String terminalId, int epoch) {
    }
}
