package com.politeness.ading.ops.dal.mapper;

/** Shared current-presence predicates for lists and activity drilldowns. */
final class OnlinePresence {
    private OnlinePresence() {}
    static final String DEVICE = " EXISTS (SELECT 1 FROM terminals t JOIN terminal_sessions s ON s.open_terminal_id = t.terminal_id WHERE t.fingerprint = d.device_uuid AND t.status != 'DISABLED' AND s.last_seen_at >= #{onlineSince}) ";
    static final String USER = " EXISTS (SELECT 1 FROM terminals t JOIN terminal_sessions s ON s.open_terminal_id = t.terminal_id WHERE " + StatisticsScope.TERMINAL_T + " AND t.owner = u.user_id AND t.status != 'DISABLED' AND s.last_seen_at >= #{onlineSince}) ";
}
