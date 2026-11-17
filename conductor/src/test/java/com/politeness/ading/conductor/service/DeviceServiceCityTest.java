package com.politeness.ading.conductor.service;

import static org.mockito.Mockito.*;
import static org.mockito.ArgumentMatchers.*;
import com.politeness.ading.conductor.dal.mapper.DeviceMapper;
import org.junit.jupiter.api.Test;

class DeviceServiceCityTest {
    @Test void phoneRegistrationRecordsRequestIpCityWithoutDesktopTelemetry() {
        var devices = mock(DeviceMapper.class);
        var cities = mock(IpCityResolver.class);
        when(cities.city("240e::1")).thenReturn("浙江省");
        new DeviceService(devices, cities).registered("phone-id", "MOBILE", "iPhone", "0.11.1", "iOS 26.1", "240e::1");
        verify(devices).upsertRegistered(eq("phone-id"), eq("mobile"), eq("iPhone"), eq("0.11.1"), eq("iOS 26.1"), any());
        verify(devices).updateCity("phone-id", "浙江省");
    }

    @Test void unknownCityDoesNotEraseAnExistingCityOrBlockRegistration() {
        var devices = mock(DeviceMapper.class);
        var cities = mock(IpCityResolver.class);
        new DeviceService(devices, cities).registered("phone-id", "MOBILE", "iPhone", null, null, "192.168.0.42");
        verify(devices, never()).updateCity(anyString(), any());
        verify(devices).upsertRegistered(eq("phone-id"), eq("mobile"), eq("iPhone"), isNull(), isNull(), any());
    }
}
