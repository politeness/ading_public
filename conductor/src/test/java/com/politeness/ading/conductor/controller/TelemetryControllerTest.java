package com.politeness.ading.conductor.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;

class TelemetryControllerTest {

    private static MockHttpServletRequest request(String remote, String realIp, String forwarded) {
        MockHttpServletRequest request = new MockHttpServletRequest();
        request.setRemoteAddr(remote);
        if (realIp != null) request.addHeader("X-Real-IP", realIp);
        if (forwarded != null) request.addHeader("X-Forwarded-For", forwarded);
        return request;
    }

    @Test
    void trustsTheProxyHeaderOnlyFromTheLocalProxy() {
        assertEquals("117.143.179.52", TelemetryController.clientIp(request("127.0.0.1", "117.143.179.52", null)), "Nginx is on this host; use the real IP it forwards");
        assertEquals("59.82.45.137", TelemetryController.clientIp(request("127.0.0.1", null, "59.82.45.137, 10.0.0.1")), "Without X-Real-IP, take the first X-Forwarded-For");
        assertEquals("8.8.8.8", TelemetryController.clientIp(request("8.8.8.8", "1.2.3.4", "1.2.3.4")), "Ignore self-reported IPs on direct external connections");
        assertEquals("192.168.3.20", TelemetryController.clientIp(request("192.168.3.20", null, null)), "Direct LAN connection (NAS dev environment) uses the connection address");
    }
}
