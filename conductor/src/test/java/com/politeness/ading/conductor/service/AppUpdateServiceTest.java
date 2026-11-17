package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyList;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.controller.dto.AppUpdateCheckRequest;
import com.politeness.ading.conductor.controller.dto.AppUpdateCheckResponse;
import com.politeness.ading.conductor.dal.entity.AppReleaseEntity;
import com.politeness.ading.conductor.dal.mapper.AppReleaseMapper;
import java.util.List;
import org.junit.jupiter.api.Test;

class AppUpdateServiceTest {

    private static final String MACHINE = "a".repeat(64);

    private static final List<String> RELEASE_AND_PRE = List.of("release", "pre");

    private final AppReleaseMapper mapper = mock(AppReleaseMapper.class);
    private final com.politeness.ading.conductor.dal.mapper.DeviceMapper devices =
            org.mockito.Mockito.mock(com.politeness.ading.conductor.dal.mapper.DeviceMapper.class);
    private final AppUpdateService service = new AppUpdateService(mapper, devices);

    /**
     * Release and pre-release builds share the same source and database: pre-release builds are pushed by name to release users on the gray list,
     * and after the full release, gray users are brought back to the release track. Who can see what is controlled by rollout and the gray list.
     */
    @Test
    void releaseAndPreReleaseSeeEachOther_devIsolated() {
        assertEquals(RELEASE_AND_PRE, AppUpdateService.visibleChannels("release"));
        assertEquals(RELEASE_AND_PRE, AppUpdateService.visibleChannels("pre"));
        assertEquals(List.of("develop"), AppUpdateService.visibleChannels("develop"));
    }

    @Test
    void preReleaseCanUpgradeToSameNumberedRelease() {
        when(mapper.findVisible("mac", RELEASE_AND_PRE, "arm64", null, MACHINE))
                .thenReturn(List.of(release("0.4.0", "ALL")));

        AppUpdateCheckResponse result = service.check(
                request("pre", "0.4.0-2026.9.19-223426-pre", MACHINE), null);

        assertTrue(result.available(), "The pre-release is a pre-release of the same-numbered release and should be superseded by it");
        assertEquals("0.4.0", result.update().version());
    }

    @Test
    void releaseUserReceivesGrayPreReleaseTargetedAtIt() {
        when(mapper.findVisible("mac", RELEASE_AND_PRE, "arm64", null, MACHINE))
                .thenReturn(List.of(release("0.5.0-2026.10.1-100000-pre", "GRAY")));

        AppUpdateCheckResponse result = service.check(request("release", "0.4.0", MACHINE), null);

        assertTrue(result.available());
        assertEquals("0.5.0-2026.10.1-100000-pre", result.update().version());
        assertTrue(result.update().gray());
    }

    @Test
    void noDowngradeWhenPreReleaseIsNewerThanRelease() {
        when(mapper.findVisible("mac", RELEASE_AND_PRE, "arm64", null, MACHINE))
                .thenReturn(List.of(release("0.4.0", "ALL")));

        AppUpdateCheckResponse result = service.check(
                request("pre", "0.5.0-2026.10.1-100000-pre", MACHINE), null);

        assertFalse(result.available(), "The installed pre-release is newer than the release and must not be pulled back to an older version");
    }

    @Test
    void picksHighestNewerVersion_bySemverNotString() {
        when(mapper.findVisible("mac", RELEASE_AND_PRE, "arm64", null, MACHINE)).thenReturn(List.of(
                release("0.9.0", "ALL"), release("0.10.0", "GRAY"), release("0.3.0", "ALL")));

        AppUpdateCheckResponse result = service.check(request("release", "0.4.0", MACHINE), null);

        assertTrue(result.available());
        assertEquals("0.10.0", result.update().version());
        assertTrue(result.update().gray());
    }

    @Test
    void returnsUnavailableWhenNoNewerVersion() {
        when(mapper.findVisible(anyString(), anyList(), anyString(), any(), any()))
                .thenReturn(List.of(release("0.4.0", "ALL")));

        AppUpdateCheckResponse result = service.check(request("release", "0.4.0", null), "u_me");

        assertFalse(result.available());
    }

    @Test
    void accountAndComputerIdPassedToQueryAsIs_computerIdLowercased() {
        service.check(request("develop", "0.4.0-2026.9.16-dev", MACHINE.toUpperCase()), "u_gray");

        verify(mapper).findVisible("mac", List.of("develop"), "arm64", "u_gray", MACHINE);
    }

    @Test
    void queriesWithNullWhenNoComputerId() {
        service.check(request("release", "0.4.0", "  "), null);

        verify(mapper).findVisible(eq("mac"), eq(RELEASE_AND_PRE), eq("arm64"), isNull(), isNull());
    }

    @Test
    void malformedVersionInDatabaseSkipsOnlyThatRow() {
        when(mapper.findVisible(anyString(), anyList(), anyString(), any(), any()))
                .thenReturn(List.of(release("v9", "ALL"), release("0.5.0", "ALL")));

        AppUpdateCheckResponse result = service.check(request("release", "0.4.0", null), null);

        assertEquals("0.5.0", result.update().version());
        assertFalse(result.update().gray());
    }

    @Test
    void requiresFullPackageBelowMinimumSupportedVersion() {
        AppReleaseEntity entity = release("0.6.0", "ALL");
        entity.setMinSupportedVersion("0.5.0");
        when(mapper.findVisible(anyString(), anyList(), anyString(), any(), any())).thenReturn(List.of(entity));

        assertTrue(service.check(request("release", "0.4.0", null), null).update().fullPackageRequired());
        assertFalse(service.check(request("release", "0.5.1", null), null).update().fullPackageRequired());
    }

    @Test
    void doesNotQueryDatabaseOnInvalidParameters() {
        assertEquals("APP_001", assertThrows(BizException.class,
                () -> service.check(request("beta", "0.4.0", null), null)).getError().code());
        assertEquals("APP_002", assertThrows(BizException.class,
                () -> service.check(request("release", "0.4", null), null)).getError().code());
        assertEquals("APP_003", assertThrows(BizException.class,
                () -> service.check(request("release", "0.4.0", "not-a-hash"), null)).getError().code());
        verify(mapper, never()).findVisible(any(), any(), any(), any(), any());
    }

    @Test
    void preChannelQueriesTogetherWithReleaseChannel() {
        when(mapper.findVisible("mac", RELEASE_AND_PRE, "arm64", null, null)).thenReturn(List.of());
        assertFalse(service.check(request("PRE", "0.4.0-2026.9.17-100000-pre", null), null).available());
        verify(mapper).findVisible("mac", RELEASE_AND_PRE, "arm64", null, null);
    }

    private static AppUpdateCheckRequest request(String channel, String version, String machineId) {
        return new AppUpdateCheckRequest(channel, "arm64", version, machineId);
    }

    private static AppReleaseEntity release(String version, String rollout) {
        AppReleaseEntity entity = new AppReleaseEntity();
        entity.setChannel("release");
        entity.setArch("arm64");
        entity.setVersion(version);
        entity.setUrl("https://example.com/ADing-" + version + ".dmg");
        entity.setSha256("b".repeat(64));
        entity.setSizeBytes(1024L);
        entity.setSigned(false);
        entity.setMandatory(false);
        entity.setRollout(rollout);
        return entity;
    }
}
