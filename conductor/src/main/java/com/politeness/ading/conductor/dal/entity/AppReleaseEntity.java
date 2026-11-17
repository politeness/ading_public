package com.politeness.ading.conductor.dal.entity;

import java.time.LocalDateTime;
import lombok.Data;

/**
 * app_releases — upgradable client versions (desktop mac, mobile ios).
 *
 * mandatory means a forced upgrade: clients below it must upgrade to it (or higher) before continuing.
 * Mobile has no installer package: url points to the App Store page and sha256 is empty.
 *
 * rollout decides who can see this version:
 *   ALL  full rollout, every client on the same channel and architecture receives it;
 *   GRAY gray release, only accounts or computers listed in app_release_grays receive it;
 *   OFF  withdrawn, nobody receives it (used to stop the bleeding when a problem is found; the row is not deleted).
 */
@Data
public class AppReleaseEntity {

    private Long          id;
    private LocalDateTime gmtCreated;
    private LocalDateTime gmtModified;
    private String        platform;
    private String        channel;
    private String        version;
    private String        arch;
    private String        url;
    private Long          sizeBytes;
    private String        sha256;
    private Boolean       signed;
    private String        teamId;
    private String        minSupportedVersion;
    private Boolean       mandatory;
    private String        notes;
    private String        rollout;
    private LocalDateTime releasedAt;

    public static final String ROLLOUT_ALL  = "ALL";
    public static final String ROLLOUT_GRAY = "GRAY";
    public static final String ROLLOUT_OFF  = "OFF";

    public static final String PLATFORM_MAC = "mac";
    public static final String PLATFORM_IOS = "ios";
}
