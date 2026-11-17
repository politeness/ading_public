package com.politeness.ading.ops.controller.dto;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Overview cards. Every number may be null; null means "this item wasn't read this time", not 0.
 *
 * The overview mixes five sources: users, devices, terminals, device_telemetry_hour and terminal_sessions.
 * If any one source breaks (table not created yet, database unreachable), only its own fields become null
 * and its source name goes into unavailable; the other numbers return as usual - the ops console would rather show one block less
 * than fail to open the whole page because the summary table is missing.
 *
 * A null earliestStatHour has two meanings, told apart by unavailable:
 * if it contains active, "the summary table can't be read"; otherwise "the table exists but has no records yet",
 * in which case the four activity metrics are real 0s, and the page must not show them as 0.
 */
public record SummaryView(
        Long userCount,
        Long deviceCount,
        Long terminalCount,
        Long onlineTerminalCount,
        Long dauToday,
        Long dauYesterday,
        Long mau30,
        Long mauMonth,
        LocalDateTime earliestStatHour,
        LocalDateTime generatedAt,
        List<String> unavailable,
        Long dauUsersToday,
        Long dauUsersYesterday,
        Long mauUsers30) {
    public SummaryView(Long userCount, Long deviceCount, Long terminalCount,
                       Long onlineTerminalCount, Long dauToday, Long dauYesterday, Long mau30,
                       Long mauMonth, LocalDateTime earliestStatHour, LocalDateTime generatedAt,
                       List<String> unavailable) {
        this(userCount, deviceCount, terminalCount, onlineTerminalCount, dauToday,
                dauYesterday, mau30, mauMonth, earliestStatHour, generatedAt, unavailable, null, null, null);
    }
}
