package com.politeness.ading.conductor.common;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;

/**
 * DATETIME in the database has no time zone; the API returns it as a time-zoned instant (UTC).
 * The desktop sorts and compares it with local time; a time without a zone would be parsed as local time and be off by 8 hours.
 */
public final class Times {

    /** Kept consistent with serverTimezone in both environments' JDBC connection strings */
    private static final ZoneId DB_ZONE = ZoneId.of("Asia/Shanghai");

    private Times() {
    }

    public static Instant instant(LocalDateTime value) {
        return value == null ? null : value.atZone(DB_ZONE).toInstant();
    }
}
