package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.SupportReportRequest;
import com.politeness.ading.conductor.controller.dto.SupportReportResponse;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.zip.GZIPOutputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;

/**
 * Verification against real OSS, skipped by default. Runs only with credentials:
 *
 * <pre>
 * OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=... \
 * ADING_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com ADING_OSS_BUCKET=<bucket name> \
 * mvn -Dtest=SupportReportOssLiveTest test
 * </pre>
 *
 * After running (pass or fail), objects uploaded to bug_report/test/... in this run are deleted.
 */
@EnabledIfEnvironmentVariable(named = "OSS_ACCESS_KEY_ID", matches = ".+")
class SupportReportOssLiveTest {

    @Test
    void uploadsImageLogAndArchiveThenReturnsReachableLinks() throws Exception {
        AdingProperties properties = new AdingProperties();
        AdingProperties.Support support = properties.getSupport();
        support.setEnabled(true);
        support.setOssEndpoint(System.getenv("ADING_OSS_ENDPOINT"));
        support.setOssBucket(System.getenv("ADING_OSS_BUCKET"));
        support.setOssAccessKeyId(System.getenv("OSS_ACCESS_KEY_ID"));
        support.setOssAccessKeySecret(System.getenv("OSS_ACCESS_KEY_SECRET"));
        support.setOssKeyPrefix("bug_report/test");

        String reportId = "report_live_" + UUID.randomUUID().toString().replace("-", "");
        // A 1x1 PNG, enough to verify the binary path
        String png = "data:image/png;base64,"
                + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        SupportReportRequest request = new SupportReportRequest(
                3, reportId, "2026-09-12T03:40:12Z", "2026-09-12T03:34:00Z",
                "实传验证：确认图片和日志都能落到 OSS",
                new SupportReportRequest.ImagePayload("阿钉截图.png", "image/png", png),
                List.of(),
                new SupportReportRequest.Context("0.1.0", "darwin", "arm64", "local",
                        List.of(new SupportReportRequest.LogPayload(
                                "last-run.log", "{\"event\":\"test\"}\n")),
                        logArchive(), null, null));

        OpsReporter reporter = org.mockito.Mockito.mock(OpsReporter.class);
        org.mockito.Mockito.when(reporter.configured()).thenReturn(true);
        SupportReportService service = new SupportReportService(properties, new ServerLogCollector(properties), reporter);
        try {
            verifyUpload(service, request, reportId);
        } finally {
            // This report has no account, so all objects are under anonymous
            assertTrue(OssTestObjects.deletePrefix("bug_report/test/anonymous/" + reportId + "/") > 0, "Test objects were not cleaned up");
        }
    }

    private void verifyUpload(SupportReportService service, SupportReportRequest request, String reportId) throws Exception {
        SupportReportResponse response = service.uploadAndNotify(request);

        assertEquals("uploaded", response.status());
        assertEquals(1, response.images().size());
        // One tail text + one full log archive
        assertEquals(2, response.logs().size());
        assertTrue(response.objectPrefix().contains(reportId));

        String imageUrl = response.images().values().iterator().next();
        // Chinese file names must be preserved: sanitizing to the same name makes multiple images overwrite each other on OSS.
        assertTrue(imageUrl.contains("screenshot-") && imageUrl.contains("%E9%98%BF%E9%92%89"),
                "Image object name lost the original file name: " + imageUrl);
        assertEquals(200, get(imageUrl), "Image URL not accessible: " + imageUrl);
        for (String logUrl : response.logs().values()) {
            assertEquals(200, get(logUrl), "Log URL not accessible: " + logUrl);
        }
        String archiveUrl = response.logs().get(ARCHIVE_NAME);
        assertTrue(archiveUrl != null && archiveUrl.contains(".tar.gz"), "Log archive not uploaded: " + archiveUrl);
        // What gets uploaded must still be a valid gzip: a corrupt archive on OSS is as good as no logs.
        assertEquals(0x1f8b, gzipMagicOf(archiveUrl));

        // Re-sending the same report should only return duplicate, without uploading again or reporting to the ops console again.
        assertEquals("duplicate", service.uploadAndNotify(request).status());
    }

    private static final String ARCHIVE_NAME = "阿钉日志-test.tar.gz";

    /** A minimal valid tar.gz: this is the kind of archive the desktop actually uploads. */
    private static SupportReportRequest.LogArchivePayload logArchive() throws Exception {
        byte[] tar = new byte[1024];
        ByteArrayOutputStream packed = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(packed)) {
            gzip.write(tar);
        }
        byte[] bytes = packed.toByteArray();
        return new SupportReportRequest.LogArchivePayload(
                ARCHIVE_NAME, Base64.getEncoder().encodeToString(bytes), 1, (long) tar.length,
                (long) bytes.length);
    }

    private static int gzipMagicOf(String url) throws Exception {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        byte[] body = client.send(
                HttpRequest.newBuilder(URI.create(url)).GET().timeout(Duration.ofSeconds(20)).build(),
                HttpResponse.BodyHandlers.ofByteArray()).body();
        return ((body[0] & 0xff) << 8) | (body[1] & 0xff);
    }

    /** Presigned links are signed for GET; verifying with HEAD gets 403 due to a signature mismatch. */
    private static int get(String url) throws Exception {
        HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .GET()
                .timeout(Duration.ofSeconds(20))
                .build();
        return client.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
    }
}
