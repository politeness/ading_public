package com.politeness.ading.ops.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockFilterChain;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class SecurityHeadersFilterTest {

    @Test
    void everyResponseCarriesTheStrictPolicy() throws Exception {
        MockHttpServletResponse response = new MockHttpServletResponse();
        new SecurityHeadersFilter().doFilter(new MockHttpServletRequest("GET", "/index.html"), response, new MockFilterChain());

        String policy = response.getHeader("Content-Security-Policy");
        assertTrue(policy.contains("script-src 'self'"));
        assertTrue(policy.contains("frame-ancestors 'none'"));
        assertFalse(policy.contains("unsafe-inline"), "Inline scripts and styles are not allowed");
        assertEquals("DENY", response.getHeader("X-Frame-Options"));
    }

    /** CSP only allows this site's files: any inline script, style or event in the page simply won't be executed by the browser */
    @Test
    void pageHasNothingInlineThatThePolicyWouldBlock() throws IOException {
        String html = read("/static/index.html");
        assertFalse(html.matches("(?s).*<script>.*"), "Scripts must live in app.js");
        assertFalse(html.contains("<style"), "Styles must live in app.css");
        assertFalse(html.matches("(?s).*\\son[a-z]+=\".*"), "No inline event handlers");
        assertFalse(html.contains(" style=\""), "No style attributes");
        assertTrue(html.contains("<script src=\"app.js\"></script>"));
        assertTrue(html.contains("href=\"app.css\""));
        String js = read("/static/app.js");
        assertFalse(js.contains("innerHTML"));
        assertFalse(js.contains("eval("));
        assertFalse(js.contains("new Function"));
    }

    private static String read(String path) throws IOException {
        try (InputStream in = SecurityHeadersFilterTest.class.getResourceAsStream(path)) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
