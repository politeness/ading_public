package com.politeness.ading.ops.service;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.LikePattern;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.config.OpsProperties;
import com.politeness.ading.ops.controller.dto.ActiveView;
import com.politeness.ading.ops.controller.dto.DeviceView;
import com.politeness.ading.ops.controller.dto.PageView;
import com.politeness.ading.ops.controller.dto.SummaryView;
import com.politeness.ading.ops.controller.dto.UserView;
import com.politeness.ading.ops.dal.ActiveBucketRow;
import com.politeness.ading.ops.dal.ActiveMemberNameRow;
import com.politeness.ading.ops.dal.OpsDeviceAccountRow;
import com.politeness.ading.ops.dal.OpsDeviceRow;
import com.politeness.ading.ops.dal.OpsUserRow;
import com.politeness.ading.ops.dal.mapper.OpsDeviceMapper;
import com.politeness.ading.ops.dal.mapper.ActiveMemberMapper;
import com.politeness.ading.ops.dal.mapper.OpsUserMapper;
import com.politeness.ading.ops.dal.mapper.ActivityMapper;
import java.time.Clock;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;

/**
 * Ops console queries and aggregation. All statistics are read-only.
 *
 * Activity definition: desktops use foreground pings (device_telemetry_hour, only present when the window was in the foreground), mobiles use connections (terminal_sessions, only connected in the foreground);
 * a desktop connected to the cloud without opening the UI isn't active.
 * DAU = deduplicated device count for the day, MAU likewise, so however many times a device connects or reports in a day it counts once.
 * Bucketing is computed in ActivityStats; buckets with no activity in the window are filled with 0 here so the frontend doesn't have to compute the date series.
 *
 * The overview mixes four sources, read in blocks: if one block can't be read (table not created yet, database hiccup), only its own fields become null,
 * the other numbers return as usual, and the page doesn't fail as a whole.
 */
@Slf4j
@Service
public class OpsStatsService {

    static final String GRANULARITY_DAY = "day";
    static final String GRANULARITY_HOUR = "hour";
    static final String SCOPE_ALL = "all";
    static final String SCOPE_TERMINAL = "terminal";

    /** The overview's four sources, also the external block names in unavailable; the page translates these names into Chinese hints */
    static final String BLOCK_ACCOUNT = "account";
    static final String BLOCK_DEVICES = "devices";
    static final String BLOCK_TERMINAL = "terminal";
    static final String BLOCK_ACTIVE = "active";

    private static final int MAX_DAY_RANGE = 90;
    private static final int MAX_HOUR_RANGE = 7;
    private static final int MAX_PAGE_SIZE = 200;
    /** conductor checks the MQTT connection about every 15 s and, while connected, writes the session's last_seen_at about every 30 s; no write for longer than this counts as offline */
    private static final long ONLINE_WINDOW_SECONDS = 90;
    /** Same window as "active in the last 30 days": 30 calendar days including today */
    private static final int ACTIVE_TERMINAL_DAYS = 30;

    /** Must match the output of DATE_FORMAT in the SQL character for character, otherwise zero-filling won't line up */
    private static final DateTimeFormatter HOUR_BUCKET =
            DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:00:00", Locale.ROOT);

    private final OpsUserMapper users;
    private final OpsDeviceMapper devices;
    private final ActivityMapper hours;
    private final Clock clock;

    @Autowired
    public OpsStatsService(OpsUserMapper users, OpsDeviceMapper devices, ActivityMapper hours,
                           OpsProperties properties, ActiveMemberMapper activeMembers) {
        this(users, devices, hours, Clock.system(properties.zoneId()), activeMembers);
    }

    OpsStatsService(OpsUserMapper users, OpsDeviceMapper devices, ActivityMapper hours, Clock clock) {
        this(users, devices, hours, clock, null);
    }

    OpsStatsService(OpsUserMapper users, OpsDeviceMapper devices, ActivityMapper hours,
                    Clock clock, ActiveMemberMapper activeMembers) {
        this.activeMembers = activeMembers;
        this.users = users;
        this.devices = devices;
        this.hours = hours;
        this.clock = clock;
    }

    private final ActiveMemberMapper activeMembers;

    public record ActivityMembers(String dimension, LocalDateTime from, LocalDateTime to,
            PageView<com.politeness.ading.ops.controller.dto.ActiveMemberView> members) {}

    public ActivityMembers activeMembers(String dimension, String period, String bucket,
                                         String granularity, String login, int page, int size) {
        if (!Set.of("users", "terminals").contains(dimension)
                || !Set.of("all", "loggedIn", "standalone").contains(login)
                || (dimension.equals("users") && !login.equals("all"))) throw new BizException(OpsError.BAD_REQUEST);
        int current = requirePage(page), limit = requireSize(size), offset = offsetOf(current, limit);
        LocalDate today = LocalDate.now(clock);
        LocalDateTime from, to;
        switch (period) {
            case "today" -> { from = today.atStartOfDay(); to = today.plusDays(1).atStartOfDay(); }
            case "yesterday" -> { from = today.minusDays(1).atStartOfDay(); to = today.atStartOfDay(); }
            case "last30" -> { from = today.minusDays(29).atStartOfDay(); to = today.plusDays(1).atStartOfDay(); }
            case "month" -> { from = today.withDayOfMonth(1).atStartOfDay(); to = today.plusDays(1).atStartOfDay(); }
            case "bucket" -> {
                String unit = normalizeGranularity(granularity);
                try {
                    from = unit.equals(GRANULARITY_HOUR) ? LocalDateTime.parse(bucket) : LocalDate.parse(bucket).atStartOfDay();
                } catch (RuntimeException invalid) { throw new BizException(OpsError.BAD_REQUEST); }
                if (!from.equals(from.truncatedTo(ChronoUnit.HOURS))
                        || from.toLocalDate().isBefore(today.minusDays(MAX_DAY_RANGE - 1))
                        || from.isAfter(LocalDateTime.now(clock))) throw new BizException(OpsError.BAD_REQUEST);
                to = unit.equals(GRANULARITY_HOUR) ? from.plusHours(1) : from.plusDays(1);
            }
            default -> throw new BizException(OpsError.BAD_REQUEST);
        }
        List<ActivityStats.Member> all = ActivityStats.members(dimension, login, hours.sessions(from, to), hours.desktopConnections(from, to), from, to);
        List<ActivityStats.Member> slice = all.subList(Math.min(offset, all.size()), Math.min(offset + limit, all.size()));
        return new ActivityMembers(dimension, from, to, new PageView<>(current, limit, all.size(), memberViews(dimension, slice)));
    }

    private List<com.politeness.ading.ops.controller.dto.ActiveMemberView> memberViews(String dimension, List<ActivityStats.Member> members) {
        if (members.isEmpty()) return List.of();
        boolean byUser = dimension.equals("users");
        Map<String, ActiveMemberNameRow> names = byId(byUser
                ? activeMembers.userNames(members.stream().map(ActivityStats.Member::id).toList())
                : activeMembers.deviceNames(members.stream().map(ActivityStats.Member::id).toList()));
        Map<String, ActiveMemberNameRow> accounts = byUser ? Map.of() : byId(accountNames(members));
        Map<String, DeviceView> deviceDetails = new HashMap<>();
        if (!byUser) {
            deviceViews(devices.devicesByIds(members.stream().map(ActivityStats.Member::id).toList(), onlineSince()))
                    .forEach(device -> deviceDetails.put(device.deviceUuid().toLowerCase(Locale.ROOT), device));
        }
        return members.stream().map(member -> {
            ActiveMemberNameRow name = names.get(member.id());
            // On the device side, "linked users" are the accounts active on this device in range, possibly more than one
            String username = byUser ? (name == null ? null : name.getUsername())
                    : member.users().stream().map(id -> accounts.containsKey(id) ? accounts.get(id).getUsername() : id)
                        .sorted().reduce((a, b) -> a + "、" + b).orElse(null);
            String deviceType = name != null && name.getDeviceType() != null ? name.getDeviceType() : member.deviceType();
            return new com.politeness.ading.ops.controller.dto.ActiveMemberView(member.id(), name == null ? null : name.getName(),
                    username, deviceType, member.lastActiveAt(), member.activeHours(), member.terminalCount(),
                    deviceDetails.get(member.id().toLowerCase(Locale.ROOT)));
        }).toList();
    }

    private List<ActiveMemberNameRow> accountNames(List<ActivityStats.Member> members) {
        List<String> ids = members.stream().flatMap(member -> member.users().stream()).distinct().toList();
        return ids.isEmpty() ? List.of() : activeMembers.userNames(ids);
    }

    private static Map<String, ActiveMemberNameRow> byId(List<ActiveMemberNameRow> rows) {
        Map<String, ActiveMemberNameRow> byId = new HashMap<>();
        rows.forEach(row -> byId.put(row.getId(), row));
        return byId;
    }

    public SummaryView summary() {
        LocalDate today = LocalDate.now(clock);
        Set<String> unavailable = new LinkedHashSet<>();

        Long userCount = read(BLOCK_ACCOUNT, unavailable, users::countRealUsers);
        Long deviceCount = read(BLOCK_DEVICES, unavailable, devices::countAllDevices);
        Long terminalCount = read(BLOCK_TERMINAL, unavailable, devices::countAllTerminals);
        Long onlineTerminalCount = read(BLOCK_TERMINAL, unavailable, () -> devices.countOnlineTerminals(onlineSince()));
        ActiveView.Totals totals = read(BLOCK_ACTIVE, unavailable, () -> totals(today));
        LocalDateTime earliestStatHour = read(BLOCK_ACTIVE, unavailable, hours::earliestStatHour);

        Long dauUsersToday = read(BLOCK_ACTIVE, unavailable, () -> hours.countActiveUsers(today.atStartOfDay(), today.plusDays(1).atStartOfDay()));
        Long dauUsersYesterday = read(BLOCK_ACTIVE, unavailable, () -> hours.countActiveUsers(today.minusDays(1).atStartOfDay(), today.atStartOfDay()));
        Long mauUsers30 = read(BLOCK_ACTIVE, unavailable, () -> hours.countActiveUsers(today.minusDays(29).atStartOfDay(), today.plusDays(1).atStartOfDay()));
        return new SummaryView(
                userCount,
                deviceCount,
                terminalCount,
                onlineTerminalCount,
                totals == null ? null : totals.dauToday(),
                totals == null ? null : totals.dauYesterday(),
                totals == null ? null : totals.mau30(),
                totals == null ? null : totals.mauMonth(),
                earliestStatHour,
                LocalDateTime.now(clock),
                List.copyOf(unavailable),
                dauUsersToday, dauUsersYesterday, mauUsers30);
    }

    /**
     * If one block of overview data can't be read, drop only that block: return null and record the block name, without throwing to the whole page.
     * Only database exceptions are swallowed; bugs in the code itself still blow up.
     */
    private <T> T read(String block, Set<String> unavailable, Supplier<T> query) {
        try {
            return query.get();
        } catch (DataAccessException e) {
            if (unavailable.add(block)) {
                log.warn("Overview data block {} failed to load: {}", block, e.getMessage());
            }
            return null;
        }
    }

    public ActiveView active(String granularity, int days) {
        String normalized = normalizeGranularity(granularity);
        boolean hourly = GRANULARITY_HOUR.equals(normalized);
        int range = normalizeDays(days, hourly);
        LocalDateTime now = LocalDateTime.now(clock);
        LocalDate today = now.toLocalDate();
        LocalDate firstDay = today.minusDays(range - 1L);
        LocalDateTime from = firstDay.atStartOfDay();
        // The hourly view only draws up to the current hour: drawing future hours as 0 would read as "nobody really used it then"
        LocalDateTime currentHour = now.truncatedTo(ChronoUnit.HOURS);
        LocalDateTime to = hourly ? currentHour.plusHours(1) : today.plusDays(1).atStartOfDay();

        Map<String, ActiveBucketRow> byBucket = ActivityStats.buckets(hours.sessions(from, to), from, to, hourly);

        List<ActiveView.Point> points = new ArrayList<>();
        if (hourly) {
            for (LocalDateTime cursor = from; !cursor.isAfter(currentHour); cursor = cursor.plusHours(1)) {
                points.add(point(HOUR_BUCKET.format(cursor), byBucket.get(HOUR_BUCKET.format(cursor))));
            }
        } else {
            for (LocalDate cursor = firstDay; !cursor.isAfter(today); cursor = cursor.plusDays(1)) {
                String bucket = cursor.toString();
                points.add(point(bucket, byBucket.get(bucket)));
            }
        }
        return new ActiveView(normalized, range, points, totals(today), hours.earliestStatHour());
    }

    public PageView<UserView> users(String keyword, int page, int size) {
        int current = requirePage(page);
        int limit = requireSize(size);
        int offset = offsetOf(current, limit);
        String pattern = LikePattern.contains(keyword);
        long total = users.countUsers(pattern);
        LocalDateTime activeSince = LocalDate.now(clock).minusDays(ACTIVE_TERMINAL_DAYS - 1L).atStartOfDay();
        List<UserView> items = users.searchUsers(pattern, activeSince, onlineSince(), offset, limit).stream()
                .map(row -> new UserView(
                        row.getUserId(), row.getUsername(), row.getDisplayName(),
                        row.getPhone(), row.getEmail(), row.getStatus(), row.getRegisteredAt(),
                        row.getTerminalCount(), row.getAgentCount(), row.getActiveTerminalCount(), row.getLastActiveAt(),
                        row.getTags() == null || row.getTags().isBlank() ? List.of() : List.of(row.getTags().split(",")),
                        row.isOnline()))
                .toList();
        return new PageView<>(current, limit, total, items);
    }

    public PageView<com.politeness.ading.ops.controller.dto.AgentView> agents(String keyword, String owner, boolean contactOnly, int page, int size) {
        int current = requirePage(page), limit = requireSize(size);
        String pattern = LikePattern.contains(keyword);
        String ownerId = blankToNull(owner);
        List<com.politeness.ading.ops.controller.dto.AgentView> items = users.searchAgents(pattern, ownerId, contactOnly, offsetOf(current, limit), limit).stream()
                .map(row -> new com.politeness.ading.ops.controller.dto.AgentView(row.getUserId(), row.getUsername(), row.getDisplayName(),
                        row.getAgentType(), row.getOwner(), row.getOwnerName(), row.getStatus(), row.getRegisteredAt(), row.isContact())).toList();
        return new PageView<>(current, limit, users.countAgentRows(pattern, ownerId, contactOnly), items);
    }

    public PageView<DeviceView> devices(String keyword, String scope, String owner, boolean activeOnly, int page, int size) {
        int current = requirePage(page);
        int limit = requireSize(size);
        String ownerId = blankToNull(owner);
        String normalizedScope = normalizeScope(scope);
        boolean registeredOnly = SCOPE_TERMINAL.equals(normalizedScope);
        LocalDateTime onlineFilterSince = "online".equals(normalizedScope) ? onlineSince() : null;
        LocalDateTime activeSince = activeOnly ? LocalDate.now(clock).minusDays(ACTIVE_TERMINAL_DAYS - 1L).atStartOfDay() : null;
        int offset = offsetOf(current, limit);
        String pattern = LikePattern.contains(keyword);
        long total = devices.countDevices(pattern, registeredOnly, onlineFilterSince, ownerId, activeSince);
        List<OpsDeviceRow> rows = devices.searchDevices(pattern, registeredOnly, onlineFilterSince, ownerId, activeSince, onlineSince(), offset, limit);
        return new PageView<>(current, limit, total, deviceViews(rows));
    }

    private List<DeviceView> deviceViews(List<OpsDeviceRow> rows) {
        Map<String, List<DeviceView.Account>> accounts = accountsOf(rows);
        return rows.stream().map(row -> new DeviceView(
                row.getDeviceUuid(), row.getDeviceType(), row.getName(), row.getOsVersion(), row.getAppVersion(),
                row.getCity(), splitAgents(row.getAgents()), row.getFirstSeenAt(), row.getLastActiveAt(), row.getStatus(),
                accounts.getOrDefault(row.getDeviceUuid().toLowerCase(Locale.ROOT), List.of()))).toList();
    }

    /** The database collation is case-insensitive and mobile UUIDs are uppercase, so lowercase both here before comparing */
    private Map<String, List<DeviceView.Account>> accountsOf(List<OpsDeviceRow> rows) {
        if (rows.isEmpty()) return Map.of();
        Map<String, List<DeviceView.Account>> byDevice = new HashMap<>();
        for (OpsDeviceAccountRow row : devices.accountsOf(rows.stream().map(OpsDeviceRow::getDeviceUuid).toList(), onlineSince())) {
            byDevice.computeIfAbsent(row.getDeviceUuid().toLowerCase(Locale.ROOT), key -> new ArrayList<>())
                    .add(new DeviceView.Account(row.getUserId(), row.getUsername(), row.getDisplayName(), row.getLastSeenAt(), row.isOnline()));
        }
        return byDevice;
    }

    private LocalDateTime onlineSince() {
        return LocalDateTime.now(clock).minusSeconds(ONLINE_WINDOW_SECONDS);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    /** The database stores a comma-separated string; the page wants an array */
    static List<String> splitAgents(String agents) {
        if (agents == null || agents.isBlank()) {
            return List.of();
        }
        return Arrays.stream(agents.split(","))
                .map(String::trim)
                .filter(value -> !value.isEmpty())
                .toList();
    }

    private ActiveView.Totals totals(LocalDate today) {
        LocalDateTime todayStart = today.atStartOfDay();
        LocalDateTime tomorrowStart = today.plusDays(1).atStartOfDay();
        return new ActiveView.Totals(
                hours.countActiveDevices(todayStart, tomorrowStart),
                hours.countActiveDevices(today.minusDays(1).atStartOfDay(), todayStart),
                averageOfCompleteDays(today, 7),
                // Last 30 days includes today; the current calendar month counts from the 1st to today
                hours.countActiveDevices(today.minusDays(29).atStartOfDay(), tomorrowStart),
                hours.countActiveDevices(today.withDayOfMonth(1).atStartOfDay(), tomorrowStart),
                hours.countActiveUsers(todayStart, tomorrowStart),
                hours.countActiveUsers(today.minusDays(1).atStartOfDay(), todayStart),
                averageOfCompleteDays(today, 7, true),
                hours.countActiveUsers(today.minusDays(29).atStartOfDay(), tomorrowStart),
                hours.countActiveUsers(today.withDayOfMonth(1).atStartOfDay(), tomorrowStart));
    }

    /**
     * Mean DAU over the span full calendar days before yesterday inclusive, excluding today: today isn't over, and counting it would visibly skew the mean low in the morning.
     * The mean is spread over the calendar days in the window, with inactive days counted as 0, not averaged only over days with data.
     */
    private double averageOfCompleteDays(LocalDate today, int span) { return averageOfCompleteDays(today, span, false); }

    private double averageOfCompleteDays(LocalDate today, int span, boolean usersDimension) {
        LocalDateTime from = today.minusDays(span).atStartOfDay();
        LocalDateTime to = today.atStartOfDay();
        Map<String, Long> byDay = new HashMap<>();
        ActivityStats.buckets(hours.sessions(from, to), from, to, false).forEach((day, row) ->
                byDay.put(day, (long) (usersDimension ? row.getUsers() : row.getTotal())));
        long sum = 0L;
        for (int i = span; i >= 1; i--) {
            sum += byDay.getOrDefault(today.minusDays(i).toString(), 0L);
        }
        return Math.round(sum * 10.0 / span) / 10.0;
    }

    private static ActiveView.Point point(String bucket, ActiveBucketRow row) {
        return row == null
                ? new ActiveView.Point(bucket, 0L, 0L, 0L)
                : new ActiveView.Point(bucket, row.getTotal(), row.getLoggedIn(), row.getStandalone(), row.getUsers());
    }

    private static String normalizeGranularity(String granularity) {
        String value = granularity == null || granularity.isBlank()
                ? GRANULARITY_DAY : granularity.trim().toLowerCase(Locale.ROOT);
        if (!GRANULARITY_DAY.equals(value) && !GRANULARITY_HOUR.equals(value)) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        return value;
    }

    private static int normalizeDays(int days, boolean hourly) {
        int max = hourly ? MAX_HOUR_RANGE : MAX_DAY_RANGE;
        if (days < 1 || days > max) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        return days;
    }

    private static String normalizeScope(String scope) {
        String value = scope == null || scope.isBlank() ? SCOPE_ALL : scope.trim().toLowerCase(Locale.ROOT);
        if (!SCOPE_ALL.equals(value) && !SCOPE_TERMINAL.equals(value) && !"online".equals(value)) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        return value;
    }

    private static int requirePage(int page) {
        if (page < 1) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        return page;
    }

    /** Compute the offset as long: a request like page=20000000, size=200 overflows int to a negative number and ends in a 500 from an SQL syntax error */
    private static int offsetOf(int page, int size) {
        long offset = (long) (page - 1) * size;
        if (offset > Integer.MAX_VALUE) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        return (int) offset;
    }

    private static int requireSize(int size) {
        if (size < 1 || size > MAX_PAGE_SIZE) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
        return size;
    }
}
