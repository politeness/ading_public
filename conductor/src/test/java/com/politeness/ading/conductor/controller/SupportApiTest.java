package com.politeness.ading.conductor.controller;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import tools.jackson.databind.ObjectMapper;
import com.politeness.ading.conductor.common.auth.AuthInterceptor;
import com.politeness.ading.conductor.common.auth.TokenEpochGuard;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.common.config.WebMvcConfig;
import com.politeness.ading.conductor.service.OpsReporter;
import com.politeness.ading.conductor.service.ServerLogCollector;
import com.politeness.ading.conductor.service.SupportReportService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
 * HTTP contract of the "Support" endpoints. The standalone edition (not signed in) must be able to call them directly, so Authorization is deliberately omitted here.
 * Loads only the web layer, no database.
 */
@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(classes = SupportApiTest.WebLayer.class)
class SupportApiTest {

    /** Wires only the web layer: bypasses the main application class's mapper scan, so the test needs no database. */
    @EnableWebMvc
    @Configuration
    @Import({SupportReportController.class, DeveloperContactController.class,
            GlobalExceptionHandler.class, SupportReportService.class, ServerLogCollector.class, OpsReporter.class,
            AuthInterceptor.class, TokenService.class, TokenEpochGuard.class, WebMvcConfig.class})
    static class WebLayer {
        @Bean
        AdingProperties adingProperties() {
            AdingProperties properties = new AdingProperties();
            properties.getAuth().setSecret("support-http-test-secret-for-unit-tests-only");
            return properties;
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

    /** The signed-out standalone edition must be able to read the config without being blocked by authentication. */
    @Test
    void configIsReadableWithoutLogin() throws Exception {
        mockMvc.perform(get("/api/v1/support/config"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.enabled").value(false))
                .andExpect(jsonPath("$.data.maxImages").value(5));
    }

    /** When the service is off, respond 503: the desktop then keeps the report in the upload outbox for retry instead of dropping it. */
    @Test
    void reportWithoutConfigurationIsUnavailableNotUnauthorized() throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(REPORT))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.message").value("Issue reporting service is not enabled"));
    }

    /** Extra fields like status and filePath from the desktop upload outbox should not make the request 400. */
    @Test
    void unknownFieldsFromTheQueueAreIgnored() throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(REPORT.replace("\"status\":\"pending-upload\"",
                                "\"status\":\"pending-upload\",\"filePath\":\"/tmp/x.json\"")))
                .andExpect(status().isServiceUnavailable());
    }

    @Test
    void missingDescriptionIsRejectedAsBadRequest() throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(REPORT.replace("\"description\":\"发送按钮没有反应\"", "\"description\":\"\"")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("COMMON_001"));
    }

    /** The log archive is a new field missing from old upload outboxes, and must not cause a 400. */
    @Test
    void reportWithoutLogArchiveIsStillAccepted() throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(REPORT))
                .andExpect(status().isServiceUnavailable());
    }

    @Test
    void logArchiveWithoutNameIsRejected() throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(REPORT.replace("\"logs\":[]",
                                "\"logs\":[],\"logArchive\":{\"name\":\"\",\"base64\":\"H4sI\"}")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void configAdvertisesTheLogArchiveLimit() throws Exception {
        mockMvc.perform(get("/api/v1/support/config"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.maxLogArchiveBytes").value(10 * 1024 * 1024));
    }

    @Test
    void contactWithoutConfigurationIsUnavailable() throws Exception {
        mockMvc.perform(post("/api/v1/support/contacts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("""
                                {"schemaVersion":1,"contactId":"contact_api",
                                 "createdAt":"2026-09-12T03:40:12Z","subject":"功能建议",
                                 "content":"希望增加会话模板","replyTo":"",
                                 "context":{"appVersion":"0.1.0","platform":"darwin",
                                            "arch":"arm64","mode":"local"}}
                                """))
                .andExpect(status().isServiceUnavailable());
    }

    /** A nonexistent path is 404. It used to fall through to 500, logging an error every time someone probed a nonexistent path. */
    @Test
    void unknownPathIsNotFoundNotServerError() throws Exception {
        mockMvc.perform(get("/no-such-page"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("COMMON_002"));
    }

    @Test
    void wrongMethodIsMethodNotAllowed() throws Exception {
        mockMvc.perform(post("/api/v1/support/config"))
                .andExpect(status().isMethodNotAllowed())
                .andExpect(jsonPath("$.message").value("Request method not supported"));
    }

    @Test
    void malformedJsonIsBadRequest() throws Exception {
        mockMvc.perform(post("/api/v1/support/reports")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{not json"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.message").value("Malformed request body"));
    }
}
