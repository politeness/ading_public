package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyFactory;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.spec.PKCS8EncodedKeySpec;
import java.time.Duration;
import java.util.Base64;
import java.util.concurrent.CompletableFuture;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import tools.jackson.databind.ObjectMapper;

/**
 * APNs HTTP/2 + token auth (.p8). The JDK's built-in HttpClient and ES256 are enough; no third-party push library.
 * When not fully configured or the key can't be read, {@link #configured()} is false: the backend starts normally but sends no pushes.
 */
@Slf4j
@Component
public class ApnsClient {

    /** Apple requires the provider token to be rotated every 20 to 60 minutes */
    private static final long TOKEN_TTL_SECONDS = 40 * 60;
    private static final ObjectMapper JSON = new ObjectMapper();

    public record Result(int status, String reason) {
        /** Token revoked (e.g. app uninstalled) or not a valid token; keeping it only keeps failing */
        public boolean tokenDead() {
            return status == 410 || (status == 400 && "BadDeviceToken".equals(reason));
        }
    }

    private final AdingProperties.Apns config;
    private final PrivateKey key;
    private final HttpClient http = HttpClient.newBuilder()
            .version(HttpClient.Version.HTTP_2)
            .connectTimeout(Duration.ofSeconds(10))
            .build();
    private String providerToken;
    private long providerTokenIssuedAt;

    public ApnsClient(AdingProperties properties) {
        this.config = properties.getApns();
        this.key = loadKey(config);
    }

    public boolean configured() {
        return key != null;
    }

    public String topic() {
        return config.getTopic();
    }

    public CompletableFuture<Result> send(PushDeviceEntity device, String payload, String collapseId) {
        return post(device, payload, collapseId).thenCompose(result -> {
            if (result.status() != 403 || !"ExpiredProviderToken".equals(result.reason())) {
                return CompletableFuture.completedFuture(result);
            }
            invalidateProviderToken();
            return post(device, payload, collapseId);
        });
    }

    private CompletableFuture<Result> post(PushDeviceEntity device, String payload, String collapseId) {
        String base = PushDeviceEntity.ENV_SANDBOX.equals(device.getEnvironment())
                ? config.getSandboxUrl() : config.getProductionUrl();
        HttpRequest request = HttpRequest.newBuilder(URI.create(base + "/3/device/" + device.getDeviceToken()))
                .timeout(Duration.ofSeconds(15))
                .header("authorization", "bearer " + providerToken())
                .header("apns-topic", config.getTopic())
                .header("apns-push-type", "alert")
                .header("apns-priority", "10")
                .header("apns-collapse-id", collapseId)
                .POST(HttpRequest.BodyPublishers.ofString(payload))
                .build();
        return http.sendAsync(request, HttpResponse.BodyHandlers.ofString())
                .thenApply(response -> new Result(response.statusCode(), reason(response.body())));
    }

    private static String reason(String body) {
        if (body == null || body.isBlank()) return null;
        try {
            var reason = JSON.readTree(body).get("reason");
            return reason == null ? null : reason.asString();
        } catch (RuntimeException unreadable) {
            return null;
        }
    }

    private synchronized String providerToken() {
        long now = System.currentTimeMillis() / 1000;
        if (providerToken == null || now - providerTokenIssuedAt >= TOKEN_TTL_SECONDS) {
            providerToken = sign(now);
            providerTokenIssuedAt = now;
        }
        return providerToken;
    }

    private synchronized void invalidateProviderToken() {
        providerToken = null;
    }

    private String sign(long issuedAt) {
        Base64.Encoder url = Base64.getUrlEncoder().withoutPadding();
        String header = url.encodeToString(JSON.writeValueAsBytes(java.util.Map.of("alg", "ES256", "kid", config.getKeyId())));
        String claims = url.encodeToString(JSON.writeValueAsBytes(java.util.Map.of("iss", config.getTeamId(), "iat", issuedAt)));
        String signingInput = header + "." + claims;
        try {
            Signature signature = Signature.getInstance("SHA256withECDSAinP1363Format");
            signature.initSign(key);
            signature.update(signingInput.getBytes(StandardCharsets.US_ASCII));
            return signingInput + "." + url.encodeToString(signature.sign());
        } catch (java.security.GeneralSecurityException error) {
            throw new IllegalStateException("APNs provider token signing failed", error);
        }
    }

    private static PrivateKey loadKey(AdingProperties.Apns config) {
        if (blank(config.getKeyId()) || blank(config.getTeamId()) || blank(config.getKeyPath()) || blank(config.getTopic())) {
            log.info("APNs not configured, mobile push disabled");
            return null;
        }
        try {
            String pem = Files.readString(Path.of(config.getKeyPath())).replaceAll("-----[A-Z ]+-----|\\s", "");
            return KeyFactory.getInstance("EC").generatePrivate(new PKCS8EncodedKeySpec(Base64.getDecoder().decode(pem)));
        } catch (Exception error) {
            // Log only the type: a wrong path shouldn't stop the whole backend, and the exception message must not include key content
            log.error("Failed to read APNs key, mobile push disabled keyPath={} reason={}", config.getKeyPath(), error.getClass().getSimpleName());
            return null;
        }
    }

    private static boolean blank(String value) {
        return value == null || value.isBlank();
    }
}
