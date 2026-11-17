package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.DeveloperContactRequest;
import com.politeness.ading.conductor.controller.dto.DeveloperContactResponse;
import com.politeness.ading.conductor.controller.dto.SupportConfigResponse;
import com.politeness.ading.conductor.controller.dto.SupportReportRequest;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

class SupportReportServiceTest {

    @Test
    void summaryTellsLocalModeApart() {
        SupportReportRequest request = request("report_mode", "local");
        assertTrue(SupportReportService.reportSummary(request, Map.of(), Map.of())
                .contains("\"mode\":\"local\""));
    }

    @Test
    void summaryEscapesDescriptionSoItStaysValidJson() {
        SupportReportRequest request = new SupportReportRequest(
                3, "report_escape", "2026-09-03T12:40:12Z", "2026-09-03T12:34:00Z",
                "点了\"发送\"之后\n什么都没有", null, List.of(),
                new SupportReportRequest.Context("0.1.0", "darwin", "arm64", "local", List.of(), null, null, null));

        String summary = SupportReportService.reportSummary(request, Map.of(), Map.of());

        assertTrue(summary.contains("\\\"发送\\\""));
        assertTrue(summary.contains("\\n"));
    }

    /** Missing collection fields should not make the whole report fail with 400. */
    @Test
    void missingCollectionsBecomeEmpty() {
        SupportReportRequest request = new SupportReportRequest(
                3, "report_null", "2026-09-03T12:40:12Z", "2026-09-03T12:34:00Z",
                "描述", null, null,
                new SupportReportRequest.Context("0.1.0", "darwin", "arm64", "local", null, null, null, null));

        assertTrue(request.images().isEmpty());
        assertTrue(request.context().logs().isEmpty());
    }

    /** Missing either OSS or the ops console is a hard failure: respond 503 so the client keeps the report and retries, never dropping it. */
    @Test
    void ossAndOpsAreBothRequired() {
        SupportReportService withoutOss = serviceWith(support -> support.setEnabled(true));
        ResponseStatusException error = assertThrows(
                ResponseStatusException.class,
                () -> withoutOss.uploadAndNotify(request("report_no_oss", "local")));
        assertTrue(error.getReason().contains("OSS"));

        SupportReportService withoutOps = serviceWith(SupportReportServiceTest::oss);
        ResponseStatusException noOps = assertThrows(
                ResponseStatusException.class,
                () -> withoutOps.notifyDeveloper(contact("contact_no_ops", List.of())));
        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, noOps.getStatusCode());
        assertFalse(withoutOps.config().reportEnabled());
        assertFalse(withoutOps.config().contactEnabled());

        SupportConfigResponse config = serviceWith(support -> {
            oss(support);
            ops(support);
        }).config();
        assertTrue(config.enabled());
        assertTrue(config.reportEnabled());
        assertTrue(config.contactEnabled());
    }

    @Test
    void disabledServiceReportsItselfAsUnavailable() {
        SupportConfigResponse config = serviceWith(support -> {}).config();
        assertFalse(config.enabled());
        assertFalse(config.reportEnabled());
        assertFalse(config.contactEnabled());
        assertEquals(5, config.maxImages());
        assertEquals(4000, config.maxDescriptionLength());
    }

    /** A contact without attachments does not touch OSS and goes straight to the ops console; duplicate submissions are not reported twice. */
    @Test
    void contactGoesToOpsOnce() {
        OpsReporter reporter = mock(OpsReporter.class);
        when(reporter.configured()).thenReturn(true);
        AdingProperties properties = new AdingProperties();
        oss(properties.getSupport());
        SupportReportService service = new SupportReportService(properties, new ServerLogCollector(properties), reporter);

        DeveloperContactResponse first = service.notifyDeveloper(contact("contact_once", List.of()));
        DeveloperContactResponse second = service.notifyDeveloper(contact("contact_once", List.of()));

        assertEquals("sent", first.status());
        assertEquals("duplicate", second.status());
        ArgumentCaptor<OpsReporter.Contact> sent = ArgumentCaptor.forClass(OpsReporter.Contact.class);
        verify(reporter).submitContact(sent.capture());
        assertEquals("功能 建议", sent.getValue().subject());
        assertEquals("希望增加会话模板", sent.getValue().content());
        assertEquals("reader@example.com", sent.getValue().replyTo());
        assertEquals("0.1.0", sent.getValue().appVersion());
        assertTrue(sent.getValue().attachments().isEmpty());
    }

    @Test
    void oversizedContactAttachmentsAreRejectedBeforeUpload() {
        OpsReporter reporter = mock(OpsReporter.class);
        when(reporter.configured()).thenReturn(true);
        AdingProperties properties = new AdingProperties();
        oss(properties.getSupport());
        SupportReportService service = new SupportReportService(properties, new ServerLogCollector(properties), reporter);

        String tooBig = Base64.getEncoder().encodeToString(new byte[SupportReportService.MAX_CONTACT_ATTACHMENT_BYTES + 1]);
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class, () -> service.notifyDeveloper(
                contact("contact_big", List.of(new DeveloperContactRequest.AttachmentPayload("a.bin", "application/octet-stream", tooBig)))))
                .getStatusCode());
        assertEquals(HttpStatus.BAD_REQUEST, assertThrows(ResponseStatusException.class, () -> service.notifyDeveloper(
                contact("contact_bad", List.of(new DeveloperContactRequest.AttachmentPayload("a.bin", "application/octet-stream", "@@")))))
                .getStatusCode());
    }

    /** Account IDs are built into the OSS path, so invalid ones must be rejected. */
    @Test
    void invalidUserIdIsRejected() {
        OpsReporter reporter = mock(OpsReporter.class);
        when(reporter.configured()).thenReturn(true);
        AdingProperties properties = new AdingProperties();
        oss(properties.getSupport());
        SupportReportService service = new SupportReportService(properties, new ServerLogCollector(properties), reporter);
        SupportReportRequest request = new SupportReportRequest(
                3, "report_bad_user", "2026-09-03T12:40:12Z", "2026-09-03T12:34:00Z", "发送按钮没有反应", null, List.of(),
                new SupportReportRequest.Context("0.1.0", "darwin", "arm64", "remote", List.of(), null, null, "../other"));
        assertEquals(HttpStatus.BAD_REQUEST,
                assertThrows(ResponseStatusException.class, () -> service.uploadAndNotify(request)).getStatusCode());
    }

    /** Old clients have no attachments field, and that must not cause a 400. */
    @Test
    void contactWithoutAttachmentFieldIsAccepted() {
        assertTrue(contact("contact_null", null).attachments().isEmpty());
    }

    /** Goes over real HTTP: with the token and JSON field names matching the ops console's input; an ops console error must become 503 so the client retries. */
    @Test
    void reporterPostsToOpsAndTurnsFailureIntoUnavailable() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        List<String> bodies = new ArrayList<>();
        List<String> tokens = new ArrayList<>();
        int[] status = {200};
        String[] reply = {"{\"code\":\"OK\",\"data\":{\"status\":\"created\"}}"};
        server.createContext("/ops/api/internal/contacts", exchange -> {
            bodies.add(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            tokens.add(exchange.getRequestHeaders().getFirst("X-Ops-Internal-Token"));
            byte[] out = reply[0].getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(status[0], out.length);
            exchange.getResponseBody().write(out);
            exchange.close();
        });
        server.start();
        try {
            AdingProperties properties = new AdingProperties();
            properties.getSupport().setOpsBaseUrl("http://127.0.0.1:" + server.getAddress().getPort() + "/ops/");
            properties.getSupport().setOpsIngestToken("token-1");
            OpsReporter reporter = new OpsReporter(properties);
            OpsReporter.Contact contact = new OpsReporter.Contact("c1", "u_1", "t_1", "2026-11-02T02:00:00Z", "主题", "内容", "",
                    "0.1.0", "darwin", "arm64", "local",
                    List.of(new OpsReporter.Attachment("file", "方案.pdf", "contact/c1/1-方案.pdf", "application/pdf", 3)));

            reporter.submitContact(contact);
            assertEquals("token-1", tokens.get(0));
            assertTrue(bodies.get(0).contains("\"contactId\":\"c1\""), bodies.get(0));
            assertTrue(bodies.get(0).contains("\"userId\":\"u_1\""), bodies.get(0));
            assertTrue(bodies.get(0).contains("\"objectKey\":\"contact/c1/1-方案.pdf\""), bodies.get(0));

            status[0] = 500;
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE,
                    assertThrows(ResponseStatusException.class, () -> reporter.submitContact(contact)).getStatusCode());
            status[0] = 200;
            reply[0] = "{\"code\":\"OPS_006\",\"message\":\"请求参数不合法\"}";
            assertEquals(HttpStatus.SERVICE_UNAVAILABLE,
                    assertThrows(ResponseStatusException.class, () -> reporter.submitContact(contact)).getStatusCode());
        } finally {
            server.stop(0);
        }
    }

    /** A time field error must say which field and what format is expected. Previously both errors shared a vague message, so callers fixed one and then hit the other. */
    @Test
    void timeErrorsNameTheFieldAndShowAnExample() {
        SupportReportService service = serviceWith(support -> {
            oss(support);
            ops(support);
        });

        ResponseStatusException noSeconds = assertThrows(ResponseStatusException.class,
                () -> service.uploadAndNotify(timed("2026-09-13T10:12:05Z", "2026-09-13T10:12")));
        assertTrue(noSeconds.getReason().startsWith("occurredAt has an invalid format"), noSeconds.getReason());
        assertTrue(noSeconds.getReason().contains("2026-09-13T18:12:30+08:00"), noSeconds.getReason());

        ResponseStatusException badCreated = assertThrows(ResponseStatusException.class,
                () -> service.uploadAndNotify(timed("yesterday", "2026-09-13T10:12:00Z")));
        assertTrue(badCreated.getReason().startsWith("createdAt has an invalid format"), badCreated.getReason());
    }

    private static void oss(AdingProperties.Support support) {
        support.setEnabled(true);
        support.setOssEndpoint("https://oss-cn-hangzhou.aliyuncs.com");
        support.setOssBucket("ading");
        support.setOssAccessKeyId("id");
        support.setOssAccessKeySecret("secret");
    }

    private static void ops(AdingProperties.Support support) {
        support.setOpsBaseUrl("http://127.0.0.1:8280/ading/ops");
        support.setOpsIngestToken("token");
    }

    private static SupportReportService serviceWith(java.util.function.Consumer<AdingProperties.Support> tune) {
        AdingProperties properties = new AdingProperties();
        tune.accept(properties.getSupport());
        return new SupportReportService(properties, new ServerLogCollector(properties), new OpsReporter(properties));
    }

    private static DeveloperContactRequest contact(String contactId, List<DeveloperContactRequest.AttachmentPayload> attachments) {
        return new DeveloperContactRequest(
                1, contactId, "2026-09-03T12:40:12Z", "功能  建议", "希望增加会话模板", "reader@example.com",
                new DeveloperContactRequest.Context("0.1.0", "darwin", "arm64", "local", null, null), attachments);
    }

    private static SupportReportRequest request(String reportId, String mode) {
        return new SupportReportRequest(
                3, reportId, "2026-09-03T12:40:12Z", "2026-09-03T12:34:00Z",
                "发送按钮没有反应", null, List.of(),
                new SupportReportRequest.Context("0.1.0", "darwin", "arm64", mode, List.of(), null, null, null));
    }

    private static SupportReportRequest timed(String createdAt, String occurredAt) {
        return new SupportReportRequest(3, "report_time", createdAt, occurredAt, "发送按钮没有反应",
                null, List.of(),
                new SupportReportRequest.Context("0.3.0", "darwin", "arm64", "local", List.of(), null, null, null));
    }
}
