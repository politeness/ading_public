package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.mapper.DeviceMapper;
import java.time.LocalDateTime;
import java.util.Locale;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/** The single write entry for device parameters. The device table only serves display and statistics; a write failure must not block login. */
@Slf4j
@Service
public class DeviceService {

    private final DeviceMapper devices;

    private final IpCityResolver cities;

    public DeviceService(DeviceMapper devices, IpCityResolver cities) {
        this.devices = devices;
        this.cities = cities;
    }

    public void registered(String fingerprint, String type, String name, String appVersion, String osVersion, String clientIp) {
        try {
            String deviceType = (type == null ? TerminalEntity.TYPE_DESKTOP : type).toLowerCase(Locale.ROOT);
            devices.upsertRegistered(fingerprint, deviceType, blankToNull(name), blankToNull(appVersion),
                    blankToNull(osVersion), LocalDateTime.now());
            String city = clientIp == null || clientIp.isBlank() ? null : cities.city(clientIp);
            if (city != null && !city.isBlank()) devices.updateCity(fingerprint, city);
        } catch (RuntimeException error) {
            log.warn("Failed to record device reason={}", error.getMessage());
        }
    }

    /** Device names come only from devices; when unreadable (table not created yet, or registered by an old backend and not backfilled), fall back to the terminal's own name, and the API must not fail because of it */
    public String nameOf(TerminalEntity terminal) {
        try {
            String name = devices.findName(terminal.getFingerprint());
            return name == null ? terminal.getName() : name;
        } catch (RuntimeException error) {
            log.warn("Failed to read device name terminalId={} reason={}", terminal.getTerminalId(), error.getMessage());
            return terminal.getName();
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }
}
