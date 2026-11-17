package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.controller.dto.TelemetryReportRequest;
import com.politeness.ading.conductor.dal.mapper.DeviceMapper;
import com.politeness.ading.conductor.dal.mapper.DeviceTelemetryMapper;
import java.time.Clock;
import java.time.LocalDateTime;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Locale;
import java.util.stream.Collectors;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

/**
 * Device telemetry: reported while the window is in the foreground. Device parameters go to devices; device_telemetry has one row per device storing the latest report,
 * and its user_id is only the last reporting account, not device ownership; device_telemetry_hour has one row per hour, which the ops console uses for DAU.
 * The standalone edition reports too (user_id empty); the city is inferred offline from the request IP, and the IP is not stored.
 */
@Slf4j
@Service
public class TelemetryService {

    private final DeviceTelemetryMapper mapper;
    private final DeviceMapper devices;
    private final IpCityResolver cities;
    private final Clock clock;

    @Autowired
    public TelemetryService(DeviceTelemetryMapper mapper, DeviceMapper devices, IpCityResolver cities) {
        this(mapper, devices, cities, Clock.systemDefaultZone());
    }

    TelemetryService(DeviceTelemetryMapper mapper, DeviceMapper devices, IpCityResolver cities, Clock clock) {
        this.mapper = mapper;
        this.devices = devices;
        this.cities = cities;
        this.clock = clock;
    }

    public void report(TelemetryReportRequest request, String userId, String clientIp) {
        String deviceUuid = request.deviceUuid().trim().toLowerCase(Locale.ROOT);
        String deviceType = request.deviceType().trim().toLowerCase(Locale.ROOT);
        String phone = blankToNull(request.phone());
        String email = blankToNull(request.email());
        String agents = request.agents() == null ? null : blankToNull(request.agents().stream()
                .map(String::trim).filter(value -> !value.isEmpty()).distinct().sorted()
                .collect(Collectors.joining(",")));
        String city = cityOf(clientIp);
        LocalDateTime now = LocalDateTime.now(clock);
        mapper.upsert(deviceUuid, userId, deviceType, phone, email, city, agents, now);
        mapper.upsertHour(now.truncatedTo(ChronoUnit.HOURS), deviceUuid, userId, deviceType, now);
        devices.upsertReported(deviceUuid, deviceType, city, blankToNull(request.appVersion()),
                blankToNull(request.osVersion()), now);
        // Inputs and results are logged; for phone and email only presence is recorded, not content
        log.info("Device telemetry deviceUuid={} userId={} deviceType={} phone={} email={} city={} agents={}",
                deviceUuid, userId, deviceType, phone != null, email != null, city, agents);
    }

    String cityOf(String ip) {
        return ip == null || ip.isBlank() ? null : cities.city(ip);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
