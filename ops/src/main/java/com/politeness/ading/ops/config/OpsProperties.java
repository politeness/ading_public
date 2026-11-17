package com.politeness.ading.ops.config;

import java.time.ZoneId;
import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;

@Getter
@Setter
@ConfigurationProperties(prefix = "ading.ops")
public class OpsProperties {

    /** Ops account list: ADing usernames, comma-separated; parsing is in OpsAccountGuard */
    private String users = "";
    private String authSecret = "";
    /** Session lifetime 12 hours; log in again on expiry, no silent renewal */
    private long sessionTtlSeconds = 43200L;
    private String cookieName = "ading_ops_session";
    private boolean cookieSecure = true;
    /**
     * Time zone the ops console uses for calendar-day cuts, hourly buckets and displayed times.
     * Must match the conductor JVM's default time zone: times in terminal_sessions are zoneless times written by conductor
     * in its system default zone, so they can only be interpreted in that same zone here.
     */
    private String zone = "Asia/Shanghai";
    private int loginMaxFailures = 5;
    private int loginWindowMinutes = 10;
    private int loginBlockMinutes = 10;
    /** Limit on concurrent password verifications; the ECS has only 2 cores and shares the host with production conductor, default 1, see VerificationGate */
    private int loginMaxConcurrentVerifications = 1;
    /** Longest wait in the queue for a verification slot; on timeout returns LOGIN_BUSY */
    private long loginVerifyWaitMillis = 3000L;
    /** Shared token used by conductor and the processing workflow to call internal endpoints; if unset, all internal requests are rejected */
    private String ingestToken = "";
    private Oss oss = new Oss();

    /** Collection, cleanup, statistics and token expiry all take the time zone from here; falls back to Asia/Shanghai if unset */
    public ZoneId zoneId() {
        return ZoneId.of(zone == null || zone.isBlank() ? "Asia/Shanghai" : zone.trim());
    }

    /** Reads attachments of issue reports and user contacts. On ECS this must be the OSS internal endpoint */
    @Getter
    @Setter
    public static class Oss {
        private String endpoint = "";
        private String bucket = "";
        private String accessKeyId = "";
        private String accessKeySecret = "";
    }

}
