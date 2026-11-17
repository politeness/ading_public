package com.politeness.ading.ops.dal.mapper;

/** Read-time exclusions only: preserve review accounts, authentication and connection history. The names come from {@link StatisticsExclusions}. */
final class StatisticsScope {
    private StatisticsScope() {}

    // A lost disconnect must stop at the last server observation, never at query time.
    private static final String SESSIONS = "SELECT ts.device_uuid, ts.user_id, d.device_type, ts.online_at AS started_at, "
            + "COALESCE(ts.offline_at, ts.last_seen_at) AS ended_at FROM terminal_sessions ts "
            + "LEFT JOIN devices d ON d.device_uuid=ts.device_uuid ";
    private static final String MOBILE = "EXISTS (SELECT 1 FROM terminals mt WHERE mt.terminal_id=ts.terminal_id AND mt.type='MOBILE')";

    /**
     * Who counts as active. Desktops use foreground pings: each hour the window was in the foreground has a row, treated as an instant with no duration; connected to the cloud without opening the UI doesn't count.
     * Mobiles don't send pings, but only connect while in the foreground, so their connection interval is the foreground interval.
     */
    static final String ACTIVITY = "(SELECT th.device_uuid, th.user_id, th.device_type, th.reported_at AS started_at, "
            + "th.reported_at AS ended_at FROM device_telemetry_hour th UNION ALL " + SESSIONS + "WHERE " + MOBILE + ")";
    /** Intervals when desktops are connected to the cloud: used only to compute online duration of active desktops, not to decide who is active. */
    static final String DESKTOP_CONNECTIONS = "(" + SESSIONS + "WHERE NOT " + MOBILE + ")";

    static final String USERS = "SELECT excluded_user.user_id FROM users excluded_user WHERE excluded_user.user_id IS NOT NULL AND excluded_user.username IS NOT NULL AND excluded_user.username != '' AND LOCATE(',', excluded_user.username) = 0 AND LOCATE(CONCAT(',', LOWER(excluded_user.username), ','), ',${" + StatisticsExclusions.VARIABLE + "},') > 0";
    // Retain shared devices whenever any recorded account is not an Apple review account.
    // Include historical sessions so logout or a later report cannot hide that evidence.
    static final String ASSOCIATIONS = "SELECT fingerprint AS device_uuid, owner AS user_id FROM terminals"
            + " UNION SELECT device_uuid, user_id FROM terminal_sessions"
            + " UNION SELECT device_uuid, user_id FROM device_telemetry_hour";
    static final String DEVICES = "SELECT association.device_uuid FROM (" + ASSOCIATIONS + ") association"
            + " WHERE association.device_uuid IS NOT NULL AND association.user_id IS NOT NULL AND association.user_id != ''"
            + " GROUP BY association.device_uuid"
            + " HAVING SUM(CASE WHEN association.user_id IN (" + USERS + ") THEN 1 ELSE 0 END) > 0"
            + " AND SUM(CASE WHEN association.user_id NOT IN (" + USERS + ") THEN 1 ELSE 0 END) = 0";
    static final String USER_U = " u.user_id NOT IN (" + USERS + ") ";
    static final String AGENT_U = " (u.owner IS NULL OR u.owner NOT IN (" + USERS + ")) ";
    static final String DEVICE_D = " d.device_uuid NOT IN (" + DEVICES + ") ";
    static final String TERMINAL_T = " t.fingerprint NOT IN (" + DEVICES + ") ";
    static final String HOUR_H = " h.device_uuid NOT IN (" + DEVICES + ") AND (h.user_id IS NULL OR h.user_id NOT IN (" + USERS + ")) ";
    static final String SESSION_S = " s.device_uuid NOT IN (" + DEVICES + ") AND (s.user_id IS NULL OR s.user_id NOT IN (" + USERS + ")) ";
}
