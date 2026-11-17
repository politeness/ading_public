package com.politeness.ading.conductor.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import tools.jackson.databind.ObjectMapper;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.common.auth.TokenType;
import com.politeness.ading.conductor.common.config.AdingProperties;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class TokenServiceTest {

    private TokenService tokenService;

    @Test
    void rejectsMissingShortAndKnownDefaultSigningSecrets() {
        for (String secret : new String[] {null, "", "short", "change-me-in-production-at-least-32-bytes-long"}) {
            AdingProperties properties = new AdingProperties();
            properties.getAuth().setSecret(secret);
            assertThrows(IllegalStateException.class, () -> new TokenService(properties, new ObjectMapper()));
        }
    }

    @BeforeEach
    void setUp() {
        AdingProperties properties = new AdingProperties();
        properties.getAuth().setSecret("unit-test-secret-that-is-long-enough-32+");
        tokenService = new TokenService(properties, new ObjectMapper());
    }

    @Test
    void issuedAccessTokenDecodesSubjectAndType() {
        String token = tokenService.issueAccessToken("u_alice", 0);
        TokenService.Claims claims = tokenService.parse(token);
        assertEquals("u_alice", claims.subject());
        assertEquals(TokenType.ACCESS, claims.type());
    }

    @Test
    void nodeTokenCarriesTerminalId() {
        String token = tokenService.issueNodeToken("u_alice", "d_mac", 0);
        TokenService.Claims claims = tokenService.parse(token);
        assertEquals(TokenType.NODE, claims.type());
        assertEquals("d_mac", claims.terminalId());
    }

    @Test
    void tamperedPayloadFailsSignatureVerification() {
        String token = tokenService.issueAccessToken("u_alice", 0);
        String[] parts = token.split("\\.");
        String tampered = parts[0] + "." + parts[1].substring(0, parts[1].length() - 2) + "AB." + parts[2];
        assertThrows(BizException.class, () -> tokenService.parse(tampered));
    }

    @Test
    void tokenSignedWithAnotherKeyIsRejected() {
        AdingProperties other = new AdingProperties();
        other.getAuth().setSecret("a-completely-different-secret-key-value!!");
        TokenService attacker = new TokenService(other, new ObjectMapper());
        String forged = attacker.issueAccessToken("u_alice", 0);
        assertThrows(BizException.class, () -> tokenService.parse(forged));
    }

    @Test
    void expiredTokenIsRejected() {
        AdingProperties expired = new AdingProperties();
        expired.getAuth().setSecret("unit-test-secret-that-is-long-enough-32+");
        expired.getAuth().setAccessTokenTtlSeconds(-10L);
        TokenService issuer = new TokenService(expired, new ObjectMapper());
        String token = issuer.issueAccessToken("u_alice", 0);
        assertThrows(BizException.class, () -> tokenService.parse(token));
    }

    @Test
    void malformedTokenIsRejected() {
        assertThrows(BizException.class, () -> tokenService.parse("not.a.jwt.at.all"));
        assertThrows(BizException.class, () -> tokenService.parse(""));
        assertThrows(BizException.class, () -> tokenService.parse(null));
    }
}
