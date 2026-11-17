package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.politeness.ading.conductor.controller.dto.TelemetryReportRequest;
import com.politeness.ading.conductor.dal.mapper.DeviceTelemetryMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

class TelemetryServiceTest {

    record Row(String deviceUuid, String userId, String deviceType, String phone, String email,
               String city, String agents, LocalDateTime reportedAt) {}

    private final List<Row> rows = new ArrayList<>();
    record Hour(LocalDateTime statHour, String deviceUuid, String userId, String deviceType, LocalDateTime reportedAt) {}

    private final List<Hour> hours = new ArrayList<>();
    private final DeviceTelemetryMapper mapper = new DeviceTelemetryMapper() {
        @Override
        public int upsert(String deviceUuid, String userId, String deviceType, String phone, String email,
                          String city, String agents, LocalDateTime reportedAt) {
            rows.add(new Row(deviceUuid, userId, deviceType, phone, email, city, agents, reportedAt));
            return 1;
        }

        @Override
        public int upsertHour(LocalDateTime statHour, String deviceUuid, String userId, String deviceType, LocalDateTime reportedAt) {
            hours.add(new Hour(statHour, deviceUuid, userId, deviceType, reportedAt));
            return 1;
        }
    };
    private final com.politeness.ading.conductor.dal.mapper.DeviceMapper devices =
            org.mockito.Mockito.mock(com.politeness.ading.conductor.dal.mapper.DeviceMapper.class);
    private final Clock clock = Clock.fixed(Instant.parse("2026-09-19T02:23:45Z"), ZoneId.of("Asia/Shanghai"));
    private static final String DEVICE = "FD0916680D88218C04F807AF76F8E20988DCF4E664D23C3CC9D620A77B1110AF";

    private static IpCityResolver fixed(String city) {
        return new IpCityResolver() {
            @Override public synchronized String city(String ip) { return ip.startsWith("192.168.") ? null : city; }
        };
    }

    @Test
    void reportsNormalizedFieldsWithTheTokenUser() {
        new TelemetryService(mapper, devices, fixed("杭州市"), clock).report(
                new TelemetryReportRequest(DEVICE, "MAC", " 13800000000 ", "", List.of("qoder", "codex", "qoder", " ")),
                "u_token", "117.143.179.52");
        Row row = rows.get(0);
        assertEquals(DEVICE.toLowerCase(), row.deviceUuid(), "Device ID is lowercased");
        assertEquals("u_token", row.userId(), "Account comes from the token");
        assertEquals("mac", row.deviceType());
        assertEquals("13800000000", row.phone());
        assertNull(row.email(), "No email stored as null");
        assertEquals("codex,qoder", row.agents(), "Available Agents deduplicated and sorted");
        assertEquals("杭州市", row.city());
        LocalDateTime at = LocalDateTime.parse("2026-09-19T10:23:45");
        assertEquals(at, row.reportedAt());
        assertEquals(List.of(new Hour(LocalDateTime.parse("2026-09-19T10:00:00"), DEVICE.toLowerCase(), "u_token", "mac", at)),
                hours, "DAU is recorded in hourly buckets; one row per hour no matter how many reports");
        org.mockito.Mockito.verify(devices).upsertReported(DEVICE.toLowerCase(), "mac", "杭州市", null, null, at);
    }

    @Test
    void standaloneReportHasNoUserAndPrivateAddressesHaveNoCity() {
        new TelemetryService(mapper, devices, fixed("杭州市"), clock).report(
                new TelemetryReportRequest(DEVICE, "mac", null, null, List.of()), null, "192.168.0.42");
        Row row = rows.get(0);
        assertNull(row.userId(), "Standalone edition has null user_id");
        assertNull(row.phone());
        assertNull(row.agents(), "No available Agent stored as null");
        assertNull(row.city(), "No city inferred for internal addresses");
        assertNull(hours.get(0).userId(), "Standalone edition hourly buckets also have no account");
    }

    /** Real address database: IPv4 only, queried from file */
    @Test
    void realDatabaseResolvesCitiesAndSkipsPrivateAndIpv6() throws Exception {
        IpCityResolver resolver = new IpCityResolver();
        try {
            String city = resolver.city("223.5.5.5");
            assertNotNull(city, "An Alibaba Cloud public address should resolve to a city");
            assertTrue(city.contains("上海") || city.contains("杭州") || city.contains("北京"), city);
            assertNull(resolver.city("192.168.0.42"), "No inference for internal network");
            assertNull(resolver.city("127.0.0.1"), "No inference for loopback");
            assertNotNull(resolver.city("240e::1"), "IPv6 should also use the address database to infer city or province");
            assertNull(resolver.city("::1"), "No inference for IPv6 loopback");
            assertNull(resolver.city("not-an-ip.invalid"), "Not an IP literal: no DNS lookup, return null directly");
            assertNull(resolver.city("240.0.0.1"), "Reserved address range is not a city");
        } finally {
            resolver.destroy();
        }
    }
}
