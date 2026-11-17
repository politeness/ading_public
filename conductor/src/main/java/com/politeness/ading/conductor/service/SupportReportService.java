package com.politeness.ading.conductor.service;

import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.model.ObjectMetadata;
import com.aliyun.oss.model.PutObjectRequest;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.DeveloperContactRequest;
import com.politeness.ading.conductor.controller.dto.DeveloperContactResponse;
import com.politeness.ading.conductor.controller.dto.SupportConfigResponse;
import com.politeness.ading.conductor.controller.dto.SupportReportRequest;
import com.politeness.ading.conductor.controller.dto.SupportReportResponse;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

/**
 * Backend "Support" capabilities: issue reports and user-contact attachments go to OSS, and the body is reported to the ops console for storage.
 *
 * <p>The standalone edition (not signed in) also calls these two endpoints, so they are outside authentication.
 *
 * <p>Clients only talk to this: OSS credentials and the ops console token are kept in the backend, and backend logs can only be collected here,
 * so old clients can report to the ops console without upgrading. If either OSS or the ops console is missing, respond 503 and the report stays in the client's upload outbox for retry.
 */
@Slf4j
@Service
public class SupportReportService {

    public static final int MAX_IMAGES = 5;
    public static final int MAX_IMAGE_BYTES = 5 * 1024 * 1024;
    public static final int MAX_LOGS = 2;
    public static final int MAX_LOG_BYTES = 1024 * 1024;
    /** Upper limit of the decoded log archive. The desktop keeps under 10 MB of logs in total, far smaller once compressed */
    public static final int MAX_LOG_ARCHIVE_BYTES = 10 * 1024 * 1024;
    public static final int MAX_DESCRIPTION_LENGTH = 4000;
    public static final int MAX_CONTACT_ATTACHMENTS = 5;
    public static final int MAX_CONTACT_ATTACHMENT_BYTES = 5 * 1024 * 1024;
    public static final int MAX_CONTACT_ATTACHMENT_TOTAL_BYTES = 15 * 1024 * 1024;

    private static final int REMEMBERED_IDS = 500;
    private static final Pattern REPORT_ID = Pattern.compile("[A-Za-z0-9_-]{1,100}");
    private static final Pattern OWNER_ID = Pattern.compile("[A-Za-z0-9_-]{1,128}");
    private static final String NO_OWNER_FOLDER = "anonymous";
    private static final Pattern MIME_TYPE = Pattern.compile("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+");
    private static final Pattern IMAGE_DATA = Pattern.compile(
            "^data:(image/(?:png|jpeg|webp));base64,(.+)$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);

    private final AdingProperties.Support properties;
    private final ServerLogCollector serverLogs;
    private final OpsReporter opsReporter;

    /**
     * The desktop upload outbox only removes a file after a success acknowledgement; a network timeout re-sends the whole thing.
     * Remember recently processed IDs and return the original result on re-send, so the same attachments are not uploaded again.
     */
    private final Map<String, SupportReportResponse> handledReports = boundedCache();
    private final Map<String, DeveloperContactResponse> handledContacts = boundedCache();

    public SupportReportService(AdingProperties adingProperties, ServerLogCollector serverLogs, OpsReporter opsReporter) {
        this.properties = adingProperties.getSupport();
        this.serverLogs = serverLogs;
        this.opsReporter = opsReporter;
    }

    private static <T> Map<String, T> boundedCache() {
        return Collections.synchronizedMap(new LinkedHashMap<>(64, 0.75f, false) {
            @Override
            protected boolean removeEldestEntry(Map.Entry<String, T> eldest) {
                return size() > REMEMBERED_IDS;
            }
        });
    }

    public SupportConfigResponse config() {
        return new SupportConfigResponse(
                properties.isEnabled(),
                properties.isEnabled() && ossConfigured() && opsReporter.configured(),
                properties.isEnabled() && ossConfigured() && opsReporter.configured(),
                MAX_IMAGES,
                MAX_IMAGE_BYTES,
                MAX_LOGS,
                MAX_LOG_BYTES,
                MAX_LOG_ARCHIVE_BYTES,
                MAX_DESCRIPTION_LENGTH);
    }

    public SupportReportResponse uploadAndNotify(SupportReportRequest request) {
        requireConfigured("Issue reporting service is not enabled");
        validateRequest(request);
        SupportReportResponse remembered = handledReports.get(request.reportId());
        if (remembered != null) {
            return new SupportReportResponse(
                    remembered.reportId(), "duplicate", remembered.objectPrefix(),
                    remembered.images(), remembered.logs());
        }

        OSS oss = new OSSClientBuilder().build(
                properties.getOssEndpoint(),
                properties.getOssAccessKeyId(),
                properties.getOssAccessKeySecret());
        // In links built by the SDK, the host comes from the client's endpoint. The upload client uses the internal network,
        // but links are opened by the desktop and people on the public internet, so a separate client with the public endpoint is needed.
        // generatePresignedUrl itself makes no network request, so the extra client adds no overhead.
        OSS signer = new OSSClientBuilder().build(
                properties.resolvedOssPublicEndpoint(),
                properties.getOssAccessKeyId(),
                properties.getOssAccessKeySecret());
        Map<String, String> images = new LinkedHashMap<>();
        Map<String, String> logs = new LinkedHashMap<>();
        List<OpsReporter.Attachment> attachments = new ArrayList<>();
        try {
            if (request.screenshot() != null) {
                uploadImage(oss, signer, request, request.screenshot(), "screenshot", "screenshot", images, attachments);
            }
            for (int index = 0; index < request.images().size(); index++) {
                uploadImage(oss, signer, request, request.images().get(index), "image-" + (index + 1), "image", images, attachments);
            }
            for (int index = 0; index < request.context().logs().size(); index++) {
                SupportReportRequest.LogPayload log = request.context().logs().get(index);
                byte[] bytes = log.content().getBytes(StandardCharsets.UTF_8);
                if (bytes.length > MAX_LOG_BYTES) badRequest("Log file cannot exceed 1 MB");
                String key = objectKey(request, "logs", (index + 1) + "-" + safeName(log.name()));
                upload(oss, key, bytes, "application/x-ndjson; charset=utf-8");
                logs.put(log.name(), objectUrl(signer, key));
                attachments.add(new OpsReporter.Attachment("log", log.name(), key, "application/x-ndjson", bytes.length));
            }
            SupportReportRequest.LogArchivePayload archive = request.context().logArchive();
            if (archive != null) {
                byte[] bytes;
                try {
                    bytes = Base64.getDecoder().decode(archive.base64());
                } catch (IllegalArgumentException error) {
                    throw new ResponseStatusException(
                            HttpStatus.BAD_REQUEST, "Invalid Base64 data in log archive", error);
                }
                if (bytes.length > MAX_LOG_ARCHIVE_BYTES) badRequest("Log archive cannot exceed 10 MB");
                String name = safeName(archive.name());
                if (name.isBlank()) name = "logs.tar.gz";
                String key = objectKey(request, "logs", name);
                upload(oss, key, bytes, "application/gzip");
                logs.put(archive.name(), objectUrl(signer, key));
                attachments.add(new OpsReporter.Attachment("log_archive", archive.name(), key, "application/gzip", bytes.length));
            }
            // Backend logs: the report itself goes through the backend; OSS upload and forwarding to the ops console both happen here,
            // and without them only the desktop half is visible. Uploaded over the internal network, like other attachments.
            serverLogs.collect().ifPresent(snapshot -> {
                String key = objectKey(request, "logs", snapshot.name());
                upload(oss, key, snapshot.content(), "application/gzip");
                logs.put(snapshot.name(), objectUrl(signer, key));
                attachments.add(new OpsReporter.Attachment("server_log", snapshot.name(), key, "application/gzip", snapshot.content().length));
            });

            String descriptionKey = objectKey(request, "", "report.json");
            upload(oss, descriptionKey, reportSummary(request, images, logs).getBytes(StandardCharsets.UTF_8),
                    "application/json; charset=utf-8");
        } finally {
            oss.shutdown();
            signer.shutdown();
        }

        opsReporter.submitFeedback(new OpsReporter.Feedback(
                request.reportId(), request.context().userId(), request.context().terminalId(), request.occurredAt(), request.createdAt(), request.description(),
                request.context().appVersion(), request.context().platform(), request.context().arch(),
                request.context().mode(), objectPrefix(request), attachments));

        SupportReportResponse response = new SupportReportResponse(
                request.reportId(), "uploaded", objectPrefix(request),
                Map.copyOf(images), Map.copyOf(logs));
        handledReports.put(request.reportId(), response);
        return response;
    }

    public DeveloperContactResponse notifyDeveloper(DeveloperContactRequest request) {
        requireConfigured("Support service is not enabled");
        if (!REPORT_ID.matcher(request.contactId()).matches()) badRequest("Invalid contact ID");
        parseTime(request.createdAt(), "createdAt", CREATED_EXAMPLE);
        DeveloperContactResponse remembered = handledContacts.get(request.contactId());
        if (remembered != null) return new DeveloperContactResponse(remembered.contactId(), "duplicate");

        List<byte[]> contents = decodeContactAttachments(request);
        List<OpsReporter.Attachment> attachments = new ArrayList<>();
        if (!contents.isEmpty()) {
            OSS oss = new OSSClientBuilder().build(
                    properties.getOssEndpoint(),
                    properties.getOssAccessKeyId(),
                    properties.getOssAccessKeySecret());
            try {
                String prefix = trim(properties.getOssCommunicationKeyPrefix()).replaceAll("^/+|/+$", "")
                        + "/" + ownerFolder(request.context().userId(), request.context().terminalId()) + "/" + request.contactId();
                for (int index = 0; index < contents.size(); index++) {
                    DeveloperContactRequest.AttachmentPayload file = request.attachments().get(index);
                    String name = safeName(file.name());
                    // Include the index: two files with the same name (or same name after sanitizing) must not overwrite each other on OSS.
                    String key = prefix + "/" + (index + 1) + "-" + (name.isBlank() ? "file" : name);
                    String contentType = safeContentType(file.mimeType());
                    upload(oss, key, contents.get(index), contentType);
                    attachments.add(new OpsReporter.Attachment("file", file.name(), key, contentType, contents.get(index).length));
                }
            } finally {
                oss.shutdown();
            }
        }
        String subject = request.subject().replaceAll("\\s+", " ").trim();
        opsReporter.submitContact(new OpsReporter.Contact(
                request.contactId(), request.context().userId(), request.context().terminalId(), request.createdAt(), subject, request.content(), request.replyTo(),
                request.context().appVersion(), request.context().platform(), request.context().arch(),
                request.context().mode(), attachments));
        DeveloperContactResponse response = new DeveloperContactResponse(request.contactId(), "sent");
        handledContacts.put(request.contactId(), response);
        return response;
    }

    private static List<byte[]> decodeContactAttachments(DeveloperContactRequest request) {
        if (request.attachments().size() > MAX_CONTACT_ATTACHMENTS) badRequest("No more than 5 attachments");
        List<byte[]> contents = new ArrayList<>();
        long total = 0;
        for (DeveloperContactRequest.AttachmentPayload file : request.attachments()) {
            byte[] bytes;
            try {
                bytes = Base64.getDecoder().decode(file.base64());
            } catch (IllegalArgumentException error) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Base64 data in attachment", error);
            }
            if (bytes.length > MAX_CONTACT_ATTACHMENT_BYTES) badRequest("Each attachment cannot exceed 5 MB");
            total += bytes.length;
            if (total > MAX_CONTACT_ATTACHMENT_TOTAL_BYTES) badRequest("Total attachment size cannot exceed 15 MB");
            contents.add(bytes);
        }
        return contents;
    }

    private static String safeContentType(String mimeType) {
        String value = trim(mimeType).toLowerCase(Locale.ROOT);
        return MIME_TYPE.matcher(value).matches() ? value : "application/octet-stream";
    }

    private void uploadImage(
            OSS oss,
            OSS signer,
            SupportReportRequest request,
            SupportReportRequest.ImagePayload image,
            String slot,
            String kind,
            Map<String, String> uploaded,
            List<OpsReporter.Attachment> attachments) {
        Matcher matcher = IMAGE_DATA.matcher(image.dataUrl());
        if (!matcher.matches() || !matcher.group(1).equalsIgnoreCase(image.mimeType())) {
            badRequest("Invalid image data format");
        }
        byte[] bytes;
        try {
            bytes = Base64.getDecoder().decode(matcher.group(2));
        } catch (IllegalArgumentException error) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid Base64 data in image", error);
        }
        if (bytes.length > MAX_IMAGE_BYTES) badRequest("Each image cannot exceed 5 MB");
        String name = safeName(image.name());
        if (name.isBlank()) name = "image" + extensionFor(image.mimeType());
        // Include the slot prefix: two images with the same name (or same name after sanitizing) must not overwrite each other on OSS.
        String key = objectKey(request, "images", slot + "-" + name);
        upload(oss, key, bytes, image.mimeType().toLowerCase(Locale.ROOT));
        uploaded.put(image.name(), objectUrl(signer, key));
        attachments.add(new OpsReporter.Attachment(kind, image.name(), key, image.mimeType().toLowerCase(Locale.ROOT), bytes.length));
    }

    private void upload(OSS oss, String key, byte[] content, String contentType) {
        ObjectMetadata metadata = new ObjectMetadata();
        metadata.setContentLength(content.length);
        metadata.setContentType(contentType);
        PutObjectRequest put = new PutObjectRequest(
                properties.getOssBucket(), key, new ByteArrayInputStream(content));
        put.setMetadata(metadata);
        oss.putObject(put);
    }

    /** The client passed in must use the public endpoint: links signed here are sent to people to click. */
    private String objectUrl(OSS signer, String key) {
        String publicBase = trim(properties.getOssPublicBaseUrl());
        if (!publicBase.isEmpty()) return publicBase.replaceAll("/+$", "") + "/" + key;
        long expiresAt = System.currentTimeMillis() + properties.getLinkTtlHours() * 3_600_000L;
        return signer.generatePresignedUrl(properties.getOssBucket(), key, new Date(expiresAt)).toString();
    }

    /** Body stored on OSS alongside the report, so the full report is visible outside the ops console too. */
    static String reportSummary(
            SupportReportRequest request,
            Map<String, String> images,
            Map<String, String> logs) {
        StringBuilder json = new StringBuilder("{");
        appendJson(json, "reportId", request.reportId(), true);
        appendJson(json, "occurredAt", request.occurredAt(), false);
        appendJson(json, "createdAt", request.createdAt(), false);
        appendJson(json, "description", request.description(), false);
        appendJson(json, "appVersion", request.context().appVersion(), false);
        appendJson(json, "platform", request.context().platform(), false);
        appendJson(json, "arch", request.context().arch(), false);
        appendJson(json, "mode", request.context().mode(), false);
        json.append(",\"images\":").append(jsonObject(images));
        json.append(",\"logs\":").append(jsonObject(logs));
        return json.append("}").toString();
    }

    private static void appendJson(StringBuilder json, String key, String value, boolean first) {
        if (!first) json.append(",");
        json.append("\"").append(key).append("\":\"").append(escape(value)).append("\"");
    }

    private static String jsonObject(Map<String, String> values) {
        StringBuilder json = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> entry : values.entrySet()) {
            if (!first) json.append(",");
            json.append("\"").append(escape(entry.getKey())).append("\":\"")
                    .append(escape(entry.getValue())).append("\"");
            first = false;
        }
        return json.append("}").toString();
    }

    private static String escape(String value) {
        StringBuilder out = new StringBuilder();
        for (char c : (value == null ? "" : value).toCharArray()) {
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        return out.toString();
    }

    /** OSS directory layout is decided by the user: bug_report and communication are both split flat by userId; queries rely on the ops console database. */
    private String objectPrefix(SupportReportRequest request) {
        return trim(properties.getOssKeyPrefix()).replaceAll("^/+|/+$", "")
                + "/" + ownerFolder(request.context().userId(), request.context().terminalId()) + "/" + request.reportId();
    }

    /** Without an account (standalone edition), split by computer ID. Old clients send neither, so they can only go into one shared directory. */
    private static String ownerFolder(String userId, String terminalId) {
        String owner = userId == null || userId.isBlank() ? terminalId : userId;
        if (owner == null || owner.isBlank()) return NO_OWNER_FOLDER;
        if (!OWNER_ID.matcher(owner).matches()) badRequest("Invalid account or terminal ID");
        return owner;
    }

    private String objectKey(SupportReportRequest request, String category, String name) {
        String folder = category == null || category.isBlank() ? "" : category + "/";
        return objectPrefix(request) + "/" + folder + safeName(name);
    }

    /**
     * Sanitizes into a safe OSS object name. Chinese must be kept: desktop screenshots are named "阿钉截图-…" by default,
     * and earlier, replacing all non-ASCII with underscores sanitized multiple images to the same name so they overwrote each other.
     * Here we only strip the directory part, control characters, and characters that break URLs or object names.
     */
    private static String safeName(String value) {
        if (value == null) return "";
        String name = value.replace('\\', '/');
        name = name.substring(name.lastIndexOf('/') + 1);
        name = name.replaceAll("[\\p{Cntrl}\"'?#%&+:*<>|]", "_")
                .replaceAll("\\s+", "_")
                .replaceAll("_+", "_")
                .replaceAll("^[._]+", "");
        return name.length() > 120 ? name.substring(name.length() - 120) : name;
    }

    private static String extensionFor(String mimeType) {
        return switch (mimeType.toLowerCase(Locale.ROOT)) {
            case "image/jpeg" -> ".jpg";
            case "image/webp" -> ".webp";
            default -> ".png";
        };
    }

    private void validateRequest(SupportReportRequest request) {
        if (!REPORT_ID.matcher(request.reportId()).matches()) badRequest("Invalid report ID");
        parseTime(request.occurredAt(), "occurredAt", OCCURRED_EXAMPLE);
        parseTime(request.createdAt(), "createdAt", CREATED_EXAMPLE);
    }

    private static final String OCCURRED_EXAMPLE = "2026-09-13T18:12:30+08:00";
    private static final String CREATED_EXAMPLE = "2026-09-13T18:12:05+08:00";

    /**
     * Parses an ISO 8601 time with time zone, to the second. Each of the two fields reports its own error with an example of the expected format,
     * so the caller can see at a glance which field is wrong.
     */
    private static OffsetDateTime parseTime(String value, String field, String example) {
        try {
            return OffsetDateTime.parse(value);
        } catch (DateTimeParseException error) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    field + " has an invalid format; expected an ISO 8601 time with a time zone, e.g. " + example, error);
        }
    }

    private boolean ossConfigured() {
        return !trim(properties.getOssEndpoint()).isEmpty()
                && !trim(properties.getOssBucket()).isEmpty()
                && !trim(properties.getOssAccessKeyId()).isEmpty()
                && !trim(properties.getOssAccessKeySecret()).isEmpty();
    }

    private void requireConfigured(String disabledMessage) {
        if (!properties.isEnabled()) unavailable(disabledMessage);
        if (!ossConfigured()) unavailable("OSS configuration is incomplete");
        if (!opsReporter.configured()) unavailable("Ops console reporting is not configured");
    }

    private static String trim(String value) {
        return value == null ? "" : value.trim();
    }

    private static void badRequest(String message) {
        throw new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private static void unavailable(String message) {
        throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, message);
    }
}
