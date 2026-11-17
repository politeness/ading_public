package com.politeness.ading.ops.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.config.OpsAccountGuard;
import com.politeness.ading.ops.config.OpsProperties;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.Base64;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import tools.jackson.databind.ObjectMapper;

/**
 * The session token is the ops console's only gate: a wrong signature, expiry, a tampered payload, or an account removed from the list must all be kept out.
 */
class OpsTokenServiceTest {

    private static final String SECRET = "a-secret-that-is-definitely-long-enough";
    private static final Instant NOW = Instant.parse("2026-10-30T06:15:00Z");
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    private static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();

    private final ObjectMapper objectMapper = new ObjectMapper();

    private OpsTokenService serviceAt(Instant instant, String secret, String users) {
        OpsProperties properties = new OpsProperties();
        properties.setAuthSecret(secret);
        properties.setUsers(users);
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles("dev");
        return new OpsTokenService(new OpsAccountGuard(properties, environment), properties, objectMapper,
                Clock.fixed(instant, ZONE));
    }

    private OpsTokenService tokens() {
        return serviceAt(NOW, SECRET, "opsadmin");
    }

    /** Signs a custom payload with the same secret, specifically to test the payload validation branches */
    private static String signed(String payloadJson) {
        String header = ENCODER.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
        String claims = ENCODER.encodeToString(payloadJson.getBytes(StandardCharsets.UTF_8));
        String signingInput = header + "." + claims;
        return signingInput + "." + ENCODER.encodeToString(hmac(signingInput));
    }

    private static byte[] hmac(String input) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(input.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static OpsError codeOf(Runnable call) {
        return assertThrows(BizException.class, call::run).error();
    }

    @Test
    void roundTripsTheClaimsItSigned() {
        OpsTokenService tokens = tokens();

        OpsTokenService.Claims claims = tokens.parse(tokens.issue("u_1", "opsadmin", 3));

        assertEquals("u_1", claims.userId());
        assertEquals("opsadmin", claims.username());
        assertEquals(3, claims.epoch());
        assertEquals(LocalDateTime.ofInstant(NOW, ZONE).plusHours(12), claims.expiresAt(), "Default session is 12 hours");
        assertEquals(claims.expiresAt(), tokens.expiresAt());
    }

    @Test
    void rejectsATokenSignedWithAnotherSecret() {
        String token = tokens().issue("u_1", "opsadmin", 0);
        OpsTokenService otherKey = serviceAt(NOW, "a-completely-different-secret-value", "opsadmin");

        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> otherKey.parse(token)));
    }

    @Test
    void rejectsAnExpiredToken() {
        String token = tokens().issue("u_1", "opsadmin", 0);
        OpsTokenService later = serviceAt(NOW.plusSeconds(12 * 3600 + 1), SECRET, "opsadmin");

        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> later.parse(token)));
    }

    @Test
    void rejectsTamperedPayloadEvenWhenTheOldSignatureIsKept() {
        OpsTokenService tokens = tokens();
        String[] parts = tokens.issue("u_1", "opsadmin", 0).split("\\.");
        String forgedClaims = ENCODER.encodeToString(
                "{\"sub\":\"u_1\",\"usr\":\"root\",\"tep\":0,\"exp\":9999999999}".getBytes(StandardCharsets.UTF_8));

        assertEquals(OpsError.NOT_LOGIN,
                codeOf(() -> tokens.parse(parts[0] + "." + forgedClaims + "." + parts[2])));
    }

    @Test
    void rejectsTruncatedAndMalformedTokensInsteadOfReturningNull() {
        OpsTokenService tokens = tokens();
        String[] parts = tokens.issue("u_1", "opsadmin", 0).split("\\.");

        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse(null)));
        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse("   ")));
        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse("abc")));
        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse("a.b")));
        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse("a.b.c.d")));
        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse("a.b.!!!")));
        assertEquals(OpsError.NOT_LOGIN,
                codeOf(() -> tokens.parse(parts[0] + "." + parts[1] + "." + parts[2].substring(1))),
                "Truncating the signature by one character fails verification");
    }

    @Test
    void rejectsPayloadsMissingRequiredClaims() {
        OpsTokenService tokens = tokens();

        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> tokens.parse(signed("{\"sub\":\"u_1\"}"))), "missing usr");
        assertEquals(OpsError.NOT_LOGIN,
                codeOf(() -> tokens.parse(signed("{\"usr\":\"opsadmin\",\"exp\":9999999999}"))), "missing sub");
        assertEquals(OpsError.NOT_LOGIN,
                codeOf(() -> tokens.parse(signed("{\"sub\":\"u_1\",\"usr\":\"opsadmin\"}"))), "missing exp");
        assertEquals(OpsError.NOT_LOGIN,
                codeOf(() -> tokens.parse(signed("{\"sub\":\"\",\"usr\":\"opsadmin\",\"exp\":9999999999}"))),
                "sub is an empty string");
        assertEquals(OpsError.NOT_LOGIN,
                codeOf(() -> tokens.parse(signed("{\"sub\":123,\"usr\":\"opsadmin\",\"exp\":9999999999}"))),
                "sub has the wrong type");
    }

    @Test
    void removingSomeoneFromTheOpsListKillsTheirLiveToken() {
        String token = tokens().issue("u_1", "opsadmin", 0);
        OpsTokenService.Claims claims = tokens().parse(token);
        tokens().requireStillOps(claims);

        // After the list is changed to someone else, the same token is rejected immediately, without waiting for the 12-hour expiry
        OpsTokenService without = serviceAt(NOW, SECRET, "teammate");
        assertEquals(OpsError.NOT_LOGIN, codeOf(() -> without.requireStillOps(claims)));
    }
}
