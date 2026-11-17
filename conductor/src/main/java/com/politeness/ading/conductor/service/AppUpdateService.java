package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.SemVer;
import com.politeness.ading.conductor.controller.dto.AppUpdateCheckRequest;
import com.politeness.ading.conductor.controller.dto.AppUpdateCheckResponse;
import com.politeness.ading.conductor.dal.entity.AppReleaseEntity;
import com.politeness.ading.conductor.dal.mapper.AppReleaseMapper;
import com.politeness.ading.conductor.dal.mapper.DeviceMapper;
import com.politeness.ading.conductor.error.AppUpdateError;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Client update checks, with gray rollout by account / computer; desktop and mobile each query their own platform.
 *
 * Rule: among the versions this client can see (full rollout + gray-list hits),
 * pick the highest one above the current version. Channel and arch must match; dev, pre and prod builds never get each other's packages.
 */
@Slf4j
@Service
public class AppUpdateService {

    /** Only these three client-reported channels are accepted; everything else is rejected */
    private static final Set<String> CHANNELS = Set.of("develop", "pre", "release");

    /**
     * Which channels' versions a client can see.
     *
     * Prod and pre are **mutually visible**: they share the same source and database; pre builds are pushed to named prod users via the gray list,
     * and after the full prod release the gray users are brought back onto the prod track. Who sees what is controlled by rollout and the gray list, not channel isolation.
     *
     * Dev is isolated on its own: it connects to the NAS, may be rebuilt a dozen times a day, and has build times in its version numbers;
     * mixing it in would only push in-development packages to real users, or switch dev machines to prod packages and interrupt development.
     */
    static List<String> visibleChannels(String channel) {
        return "develop".equals(channel) ? List.of("develop") : List.of("release", "pre");
    }

    private static final Set<String> PLATFORMS = Set.of(AppReleaseEntity.PLATFORM_MAC, AppReleaseEntity.PLATFORM_IOS);

    /** Format of terminals.fingerprint: sha256 hex */
    private static final Pattern MACHINE_ID = Pattern.compile("^[0-9a-f]{64}$");

    private final AppReleaseMapper appReleaseMapper;

    private final DeviceMapper devices;

    public AppUpdateService(AppReleaseMapper appReleaseMapper, DeviceMapper devices) {
        this.appReleaseMapper = appReleaseMapper;
        this.devices = devices;
    }

    /** Desktop builds of every version bring their version when checking for updates, so the ops console can see whether all are updated; statistics only, failures must not affect the check */
    private void recordVersion(String machineId, String version) {
        if (machineId == null) return;
        try {
            devices.updateAppVersion(machineId, version);
        } catch (RuntimeException error) {
            log.warn("Failed to record device version reason={}", error.getMessage());
        }
    }

    /**
     * @param userId the verified logged-in account; null for the standalone version or when not logged in
     */
    public AppUpdateCheckResponse check(AppUpdateCheckRequest request, String userId) {
        String channel = request.channel().trim().toLowerCase(Locale.ROOT);
        if (!CHANNELS.contains(channel)) {
            throw new BizException(AppUpdateError.BAD_CHANNEL);
        }
        SemVer current = SemVer.tryParse(request.currentVersion());
        if (current == null) {
            throw new BizException(AppUpdateError.BAD_VERSION);
        }
        String platform = request.platform() == null || request.platform().isBlank()
                ? AppReleaseEntity.PLATFORM_MAC : request.platform().trim().toLowerCase(Locale.ROOT);
        if (!PLATFORMS.contains(platform)) {
            throw new BizException(AppUpdateError.BAD_PLATFORM);
        }
        String machineId = normalizeMachineId(request.machineId());
        String arch = request.arch().trim();
        recordVersion(machineId, request.currentVersion().trim());

        List<AppReleaseEntity> visible = appReleaseMapper.findVisible(platform, visibleChannels(channel), arch, userId, machineId);
        List<Candidate> newer = visible.stream()
                .map(entity -> new Candidate(entity, parseStored(entity)))
                .filter(c -> c.version() != null && c.version().compareTo(current) > 0)
                .toList();
        Optional<Candidate> chosen = newer.stream().max(Comparator.comparing(Candidate::version));
        // Skipping intermediate versions doesn't avoid a forced upgrade: if any skipped version is forced, the upgrade is required
        Optional<Candidate> required = newer.stream()
                .filter(c -> Boolean.TRUE.equals(c.entity().getMandatory()))
                .max(Comparator.comparing(Candidate::version));
        // Inputs and results must be visible in logs: which computer, which account, what current version, which version was given, and whether via gray rollout.
        // On 2026-09-18, while investigating "didn't receive the update", there was no log here and we had to guess the computer from Nginx access logs.
        log.info("Update check platform={} channel={} visibleChannels={} arch={} current={} machineId={} userId={} visible={} result={} required={}",
                platform, channel, visibleChannels(channel), arch, request.currentVersion(), machineId, userId, visible.size(),
                chosen.map(c -> c.entity().getVersion() + (Objects.equals(c.entity().getRollout(), AppReleaseEntity.ROLLOUT_GRAY) ? "(gray)" : "")).orElse("none"),
                required.map(c -> c.entity().getVersion()).orElse("none"));
        String requiredVersion = required.map(c -> c.entity().getVersion()).orElse(null);
        return chosen
                .map(c -> AppUpdateCheckResponse.of(toUpdate(c.entity(), current, requiredVersion)))
                .orElseGet(AppUpdateCheckResponse::none);
    }

    private static String normalizeMachineId(String raw) {
        if (raw == null || raw.isBlank()) return null;
        String value = raw.trim().toLowerCase(Locale.ROOT);
        if (!MACHINE_ID.matcher(value).matches()) {
            throw new BizException(AppUpdateError.BAD_MACHINE_ID);
        }
        return value;
    }

    /** One mistyped version in the database only skips that row; it must not make every client's check fail */
    private static SemVer parseStored(AppReleaseEntity entity) {
        SemVer version = SemVer.tryParse(entity.getVersion());
        if (version == null) {
            log.warn("Unparseable version in app_releases, skipped: id={} version={}",
                    entity.getId(), entity.getVersion());
        }
        return version;
    }

    private static AppUpdateCheckResponse.Update toUpdate(AppReleaseEntity entity, SemVer current, String requiredVersion) {
        SemVer min = SemVer.tryParse(entity.getMinSupportedVersion());
        return new AppUpdateCheckResponse.Update(
                entity.getVersion(),
                entity.getUrl(),
                entity.getSizeBytes(),
                entity.getSha256(),
                Boolean.TRUE.equals(entity.getSigned()),
                entity.getTeamId(),
                requiredVersion != null,
                requiredVersion,
                min != null && current.compareTo(min) < 0,
                Objects.equals(entity.getRollout(), AppReleaseEntity.ROLLOUT_GRAY),
                entity.getNotes(),
                entity.getReleasedAt() == null ? null : entity.getReleasedAt().toString());
    }

    private record Candidate(AppReleaseEntity entity, SemVer version) {
    }
}
