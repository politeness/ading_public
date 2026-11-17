package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.config.AdingProperties;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Reports issue feedback and user contacts to the ops console (ops /api/internal, verified with a shared token). The body is stored in the ops database; attachments live in OSS.
 *
 * <p>Any failure to report returns 503: the desktop outbox only removes files after a success receipt and re-uploads everything next round.
 * On re-upload the object keys stay the same and the ops console is idempotent by ID, so no extra entry appears.
 */
@Slf4j
@Component
public class OpsReporter {

    private static final String TOKEN_HEADER = "X-Ops-Internal-Token";

    public record Attachment(String kind, String name, String objectKey, String contentType, long sizeBytes) {
    }

    public record Feedback(String reportId, String userId, String terminalId, String occurredAt, String createdAt, String description,
                           String appVersion, String platform, String arch, String mode,
                           String objectPrefix, List<Attachment> attachments) {
    }

    public record Contact(String contactId, String userId, String terminalId, String createdAt, String subject, String content, String replyTo,
                          String appVersion, String platform, String arch, String mode,
                          List<Attachment> attachments) {
    }

    private final AdingProperties.Support properties;
    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build();

    public OpsReporter(AdingProperties adingProperties) {
        this.properties = adingProperties.getSupport();
    }

    public boolean configured() {
        return !trim(properties.getOpsBaseUrl()).isEmpty() && !trim(properties.getOpsIngestToken()).isEmpty();
    }

    public void submitFeedback(Feedback feedback) {
        post("/api/internal/feedback", feedback, feedback.reportId());
    }

    public void submitContact(Contact contact) {
        post("/api/internal/contacts", contact, contact.contactId());
    }

    private void post(String path, Object payload, String id) {
        String url = trim(properties.getOpsBaseUrl()).replaceAll("/+$", "") + path;
        try {
            HttpResponse<String> response = http.send(
                    HttpRequest.newBuilder(URI.create(url))
                            .timeout(Duration.ofSeconds(10))
                            .header("Content-Type", "application/json")
                            .header(TOKEN_HEADER, trim(properties.getOpsIngestToken()))
                            .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(payload), StandardCharsets.UTF_8))
                            .build(),
                    HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            if (!accepted(response)) {
                log.error("Ops console rejected id={} url={} status={} body={}", id, url, response.statusCode(), response.body());
                throw unavailable(null);
            }
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
            throw unavailable(error);
        } catch (java.io.IOException | IllegalArgumentException error) {
            log.error("Failed to call ops console id={} url={}", id, url, error);
            throw unavailable(error);
        }
    }

    private boolean accepted(HttpResponse<String> response) {
        if (response.statusCode() != 200) return false;
        JsonNode code = json.readTree(response.body()).path("code");
        return "OK".equals(code.asString(""));
    }

    private static ResponseStatusException unavailable(Exception cause) {
        return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Ops console temporarily unavailable", cause);
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }
}
