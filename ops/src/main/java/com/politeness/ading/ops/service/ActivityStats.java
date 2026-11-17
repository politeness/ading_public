package com.politeness.ading.ops.service;

import com.politeness.ading.ops.dal.ActiveBucketRow;
import com.politeness.ading.ops.dal.ActivitySessionRow;
import java.time.Duration;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * Daily actives and duration. Who is active is decided by activity records: desktops use foreground pings (an instant), mobiles use connection intervals.
 * Duration is online duration: mobiles use their connection intervals, desktops use the cloud connection intervals of those active in range; desktops that never opened the UI are excluded.
 */
final class ActivityStats {

    private static final DateTimeFormatter HOUR_BUCKET = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:00:00", Locale.ROOT);

    private ActivityStats() {}

    /** Deduplicated counts bucketed by day or by hour. Keys match the bucket names OpsStatsService uses for zero-filling */
    static Map<String, ActiveBucketRow> buckets(List<ActivitySessionRow> sessions,
                                                LocalDateTime from, LocalDateTime to, boolean hourly) {
        Map<String, Tally> tallies = new HashMap<>();
        for (ActivitySessionRow row : sessions) {
            LocalDateTime cursor = truncate(row.getOnlineAt().isBefore(from) ? from : row.getOnlineAt(), hourly);
            for (; (cursor.isBefore(row.getEndedAt()) || cursor.equals(row.getOnlineAt())) && cursor.isBefore(to); cursor = hourly ? cursor.plusHours(1) : cursor.plusDays(1)) {
                tallies.computeIfAbsent(bucketName(cursor, hourly), key -> new Tally())
                        .add(row.getDeviceUuid(), row.getUserId(), row.getUserId() != null);
            }
        }
        Map<String, ActiveBucketRow> rows = new HashMap<>();
        tallies.forEach((bucket, tally) -> rows.put(bucket, tally.toRow(bucket)));
        return rows;
    }

    /** Users or devices active in range, most recently active first */
    static List<Member> members(String dimension, String login, List<ActivitySessionRow> sessions,
                                List<ActivitySessionRow> desktopConnections, LocalDateTime from, LocalDateTime to) {
        boolean byUser = "users".equals(dimension);
        Map<String, MemberTally> tallies = new HashMap<>();
        // The details' "most recent activity in range" can't exceed the range: for a session running into the next day, yesterday's latest activity is yesterday's last second
        LocalDateTime lastInstant = to.minusNanos(1);
        for (ActivitySessionRow row : sessions) {
            if (byUser ? row.getUserId() == null : !loginMatches(login, row.getUserId() != null)) continue;
            MemberTally tally = tallies.computeIfAbsent(byUser ? row.getUserId() : row.getDeviceUuid(), MemberTally::new);
            tally.devices.add(row.getDeviceUuid());
            if (row.getUserId() != null) tally.users.add(row.getUserId());
            tally.deviceType = row.getDeviceType();
            tally.intervals.computeIfAbsent(row.getDeviceUuid(), key -> new ArrayList<>()).add(row);
            tally.seen(row.getEndedAt().isAfter(lastInstant) ? lastInstant : row.getEndedAt());
        }
        for (ActivitySessionRow row : desktopConnections) {
            MemberTally tally = tallies.get(byUser ? row.getUserId() : row.getDeviceUuid());
            // In the account dimension, desktops this account is connected on but never opened the UI on don't count toward duration
            if (tally == null || !tally.devices.contains(row.getDeviceUuid())) continue;
            tally.intervals.computeIfAbsent(row.getDeviceUuid(), key -> new ArrayList<>()).add(row);
        }
        return tallies.values().stream()
                .map(tally -> new Member(tally.id, tally.deviceType, tally.lastActiveAt, tally.hours(from, to),
                        tally.devices.size(), List.copyOf(tally.users)))
                .sorted(Comparator.comparing(Member::lastActiveAt, Comparator.reverseOrder()).thenComparing(Member::id))
                .toList();
    }

    /** Overlaps count once: a device looks at its own sessions (switching accounts, two accounts open at once), an account at the sessions of all its devices */
    static long overlapSeconds(List<ActivitySessionRow> sessions, LocalDateTime from, LocalDateTime to) {
        List<ActivitySessionRow> sorted = sessions.stream().sorted(Comparator.comparing(ActivitySessionRow::getOnlineAt)).toList();
        long milliseconds = 0;
        LocalDateTime covered = from;
        for (ActivitySessionRow row : sorted) {
            LocalDateTime start = row.getOnlineAt().isBefore(covered) ? covered : row.getOnlineAt();
            LocalDateTime end = row.getEndedAt().isAfter(to) ? to : row.getEndedAt();
            if (end.isAfter(start)) {
                milliseconds += Duration.between(start, end).toMillis();
                covered = end;
            }
        }
        return milliseconds / 1000;
    }

    private static boolean loginMatches(String login, boolean loggedIn) {
        return switch (login) {
            case "loggedIn" -> loggedIn;
            case "standalone" -> !loggedIn;
            default -> true;
        };
    }

    private static LocalDateTime truncate(LocalDateTime at, boolean hourly) {
        return at.truncatedTo(hourly ? ChronoUnit.HOURS : ChronoUnit.DAYS);
    }

    private static String bucketName(LocalDateTime at, boolean hourly) {
        return hourly ? HOUR_BUCKET.format(at) : at.toLocalDate().toString();
    }

    record Member(String id, String deviceType, LocalDateTime lastActiveAt, Double activeHours, int terminalCount, List<String> users) {}

    private static final class Tally {
        private final Set<String> devices = new HashSet<>();
        private final Set<String> users = new HashSet<>();
        private final Set<String> loggedIn = new HashSet<>();
        private final Set<String> standalone = new HashSet<>();

        void add(String device, String user, boolean signedIn) {
            devices.add(device);
            if (user != null) users.add(user);
            (signedIn ? loggedIn : standalone).add(device);
        }

        ActiveBucketRow toRow(String bucket) {
            ActiveBucketRow row = new ActiveBucketRow();
            row.setBucket(bucket);
            row.setTotal(devices.size());
            row.setUsers(users.size());
            row.setLoggedIn(loggedIn.size());
            row.setStandalone(standalone.size());
            return row;
        }
    }

    private static final class MemberTally {
        private final String id;
        private final Set<String> devices = new HashSet<>();
        private final Set<String> users = new HashSet<>();
        private final Map<String, List<ActivitySessionRow>> intervals = new HashMap<>();
        private String deviceType;
        private LocalDateTime lastActiveAt;

        MemberTally(String id) {
            this.id = id;
        }

        void seen(LocalDateTime at) {
            if (lastActiveAt == null || at.isAfter(lastActiveAt)) lastActiveAt = at;
        }

        /** Sum of online duration per device; overlapping intervals on the same device count once. */
        Double hours(LocalDateTime from, LocalDateTime to) {
            long seconds = intervals.values().stream().mapToLong(rows -> overlapSeconds(rows, from, to)).sum();
            // Standalone desktops only have foreground ping instants and no connections, so duration is unknown
            return seconds == 0 ? null : Math.round(seconds / 36.0) / 100.0;
        }
    }
}
