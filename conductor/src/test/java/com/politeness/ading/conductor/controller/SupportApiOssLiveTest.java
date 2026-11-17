package com.politeness.ading.conductor.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import tools.jackson.databind.ObjectMapper;
import com.politeness.ading.conductor.common.auth.AuthInterceptor;
import com.politeness.ading.conductor.common.auth.TokenEpochGuard;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.common.config.WebMvcConfig;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.service.OpsReporter;
import com.politeness.ading.conductor.service.OssTestObjects;
import com.politeness.ading.conductor.service.ServerLogCollector;
import com.politeness.ading.conductor.service.SupportReportService;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.context.web.WebAppConfiguration;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;

/**
 * End-to-end verification from the HTTP entry to OSS once real OSS is configured. Skipped by default; runs only with credentials:
 *
 * <pre>
 * OSS_ACCESS_KEY_ID=... OSS_ACCESS_KEY_SECRET=... \
 * ADING_OSS_ENDPOINT=https://oss-cn-shanghai.aliyuncs.com ADING_OSS_BUCKET=<bucket name> \
 * mvn -Dtest=SupportApiOssLiveTest test
 * </pre>
 *
 * After running (pass or fail), objects uploaded to bug_report/test/... in this run are deleted.
 *
 * It is a separate class because the context it needs (support service enabled) is the opposite of SupportApiTest (not configured).
 */
@EnabledIfEnvironmentVariable(named = "OSS_ACCESS_KEY_ID", matches = ".+")
@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(classes = SupportApiOssLiveTest.WebLayer.class)
class SupportApiOssLiveTest {

    @EnableWebMvc
    @Configuration
    @Import({SupportReportController.class, GlobalExceptionHandler.class,
            SupportReportService.class, ServerLogCollector.class,
            AuthInterceptor.class, TokenService.class, TokenEpochGuard.class, WebMvcConfig.class})
    static class WebLayer {
        @Bean
        AdingProperties adingProperties() {
            AdingProperties properties = new AdingProperties();
            properties.getAuth().setSecret("support-http-test-secret-for-unit-tests-only");
            AdingProperties.Support support = properties.getSupport();
            support.setEnabled(true);
            support.setOssEndpoint(System.getenv("ADING_OSS_ENDPOINT"));
            support.setOssBucket(System.getenv("ADING_OSS_BUCKET"));
            support.setOssAccessKeyId(System.getenv("OSS_ACCESS_KEY_ID"));
            support.setOssAccessKeySecret(System.getenv("OSS_ACCESS_KEY_SECRET"));
            support.setOssKeyPrefix("bug_report/test");
            return properties;
        }

        /** Verifies only up to OSS; the ops console reporting logic is in SupportReportServiceTest. */
        @Bean
        OpsReporter opsReporter() {
            OpsReporter reporter = org.mockito.Mockito.mock(OpsReporter.class);
            org.mockito.Mockito.when(reporter.configured()).thenReturn(true);
            return reporter;
        }

        @Bean
        ObjectMapper objectMapper() {
            return new ObjectMapper();
        }

        /** This slice has no database; the auth interceptor checks the token generation, so a no-op implementation is enough */
        @Bean
        UserMapper userMapper() {
            return org.mockito.Mockito.mock(UserMapper.class);
        }
    }

    @Autowired
    private WebApplicationContext context;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context).build();
    }

    private static final String REPORT = """
            {"schemaVersion":3,"reportId":"report_api","createdAt":"2026-09-12T03:40:12Z",
             "occurredAt":"2026-09-12T03:34:00Z","status":"pending-upload",
             "description":"发送按钮没有反应","images":[],
             "context":{"appVersion":"0.1.0","platform":"darwin","arch":"arm64","mode":"local","logs":[]}}
            """;

    /**
     * With OSS configured, a report coming in through the HTTP entry must actually land on OSS, with an accessible URL in the receipt.
     * Skipped without credentials.
     */
    @Test
    void configuredReportGoesAllTheWayToOss() throws Exception {
        String reportId = "report_api_live_" + UUID.randomUUID().toString().replace("-", "");
        String png = "data:image/png;base64,"
                + "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        String body = REPORT
                .replace("report_api", reportId)
                .replace("\"images\":[]",
                        "\"images\":[{\"name\":\"阿钉截图.png\",\"mimeType\":\"image/png\",\"dataUrl\":\"" + png + "\"}]");
        try {
            postTwice(body);
        } finally {
            // This report has no account, so all objects are under anonymous
            org.junit.jupiter.api.Assertions.assertTrue(
                    OssTestObjects.deletePrefix("bug_report/test/anonymous/" + reportId + "/") > 0, "Test objects were not cleaned up");
        }
    }

    private void postTwice(String body) throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.status").value("uploaded"))
                .andExpect(jsonPath("$.data.images['阿钉截图.png']").exists());

        // When the desktop re-sends the same report after a timeout, it should not be uploaded again.
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("duplicate"));
    }
}
