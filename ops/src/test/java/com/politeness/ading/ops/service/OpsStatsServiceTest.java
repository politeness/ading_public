package com.politeness.ading.ops.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyBoolean;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.controller.dto.ActiveView;
import com.politeness.ading.ops.controller.dto.SummaryView;
import com.politeness.ading.ops.controller.dto.DeviceView;
import com.politeness.ading.ops.dal.ActivitySessionRow;
import com.politeness.ading.ops.dal.OpsDeviceAccountRow;
import com.politeness.ading.ops.dal.OpsDeviceRow;
import com.politeness.ading.ops.dal.mapper.ActiveMemberMapper;
import com.politeness.ading.ops.dal.mapper.OpsDeviceMapper;
import com.politeness.ading.ops.dal.mapper.OpsUserMapper;
import com.politeness.ading.ops.dal.mapper.ActivityMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataAccessResourceFailureException;

/**
 * The activity definition is where the ops console most easily miscounts: whether buckets are zero-filled, where the hourly series stops,
 * whether the mean may average only days with data, and the window bounds of the last 30 days and the current calendar month are all pinned here.
 */
class OpsStatsServiceTest {

    /** Fixed at 2026-10-30 14:15 Shanghai time */
    private static final Clock CLOCK =
            Clock.fixed(Instant.parse("2026-10-30T06:15:00Z"), ZoneId.of("Asia/Shanghai"));
    private static final LocalDateTime TODAY_START = LocalDateTime.parse("2026-10-30T00:00:00");
    private static final LocalDateTime TOMORROW_START = LocalDateTime.parse("2026-10-31T00:00:00");

    /** When a table isn't created yet or the database hiccups, MyBatis throws DataAccessException; the overview swallows only this kind */
    private static final DataAccessException HOUR_TABLE_MISSING =
            new DataAccessResourceFailureException("Table 'ading.terminal_sessions' doesn't exist");
    private static final DataAccessException USERS_UNREADABLE =
            new DataAccessResourceFailureException("Table 'ading.users' is unreadable");
    private static final DataAccessException TERMINALS_MISSING =
            new DataAccessResourceFailureException("Table 'ading.terminals' doesn't exist");

    private final OpsUserMapper users = mock(OpsUserMapper.class);
    private final OpsDeviceMapper devices = mock(OpsDeviceMapper.class);
    private final ActivityMapper hours = mock(ActivityMapper.class);
    private final ActiveMemberMapper activeMemberNames = mock(ActiveMemberMapper.class);
    private final OpsStatsService stats = new OpsStatsService(users, devices, hours, CLOCK);

    /** This hourly bucket has loggedIn logged-in devices and standalone standalone devices */
    private static List<ActivitySessionRow> bucket(String hour, int loggedIn, int standalone) {
        List<ActivitySessionRow> rows = new ArrayList<>();
        for (int i = 0; i < loggedIn + standalone; i++) {
            ActivitySessionRow row = new ActivitySessionRow();
            row.setOnlineAt(LocalDateTime.parse(hour));
            row.setDeviceUuid(hour + "-" + i);
            row.setUserId(i < loggedIn ? "u" + i : null);
            row.setEndedAt(LocalDateTime.parse(hour));
            rows.add(row);
        }
        return rows;
    }

    private static ActivitySessionRow session(String device, String user, String on, String end) {
        ActivitySessionRow row = new ActivitySessionRow();
        row.setDeviceUuid(device);
        row.setUserId(user);
        row.setOnlineAt(LocalDateTime.parse(on));
        row.setEndedAt(LocalDateTime.parse(end));
        return row;
    }

    @Test
    void userAndDeviceDauUseSeparateNaturalDayCounts() {
        when(hours.countActiveDevices(TODAY_START, TOMORROW_START)).thenReturn(4L);
        when(hours.countActiveUsers(TODAY_START, TOMORROW_START)).thenReturn(2L);
        var summary = stats.summary();
        assertEquals(4L, summary.dauToday());
        assertEquals(2L, summary.dauUsersToday());
        when(hours.countActiveUsers(TODAY_START.minusDays(29), TOMORROW_START)).thenReturn(3L);
        assertEquals(3L, stats.summary().mauUsers30());
        assertEquals(3L, stats.active("day", 1).totals().mauUsers30());
        assertEquals(2L, stats.active("day", 1).totals().dauUsersToday());
    }

    @Test
    void daySeriesFillsEmptyBucketsSoFrontendNeedsNoDateMath() {
        when(hours.sessions(any(), any())).thenReturn(bucket("2026-10-29T09:00:00", 3, 1));

        List<ActiveView.Point> points = stats.active("day", 3).points();

        assertEquals(List.of("2026-10-28", "2026-10-29", "2026-10-30"),
                points.stream().map(ActiveView.Point::bucket).toList(), "The window is filled continuously by calendar day");
        assertEquals(0, points.get(0).total(), "Days without data are filled with 0, not dropped");
        assertEquals(4, points.get(1).total());
        assertEquals(3, points.get(1).loggedIn());
        assertEquals(1, points.get(1).standalone());
    }

    @Test
    void hourSeriesStopsAtCurrentHourAndNeverDrawsTheFuture() {
        when(hours.sessions(any(), any())).thenReturn(bucket("2026-10-30T13:00:00", 2, 0));

        List<ActiveView.Point> points = stats.active("hour", 1).points();

        assertEquals(15, points.size(), "15 buckets from 00:00 to 14:00");
        assertEquals("2026-10-30T00:00:00", points.get(0).bucket(), "The format must match SQL's DATE_FORMAT");
        assertEquals("2026-10-30T14:00:00", points.get(14).bucket(), "Stops at the current hour; future hours aren't drawn as 0");
        assertEquals(2, points.get(13).total());
        assertEquals(0, points.get(14).total());
    }

    @Test
    void hourRangeAsksForTheRightWindow() {
        stats.active("hour", 2);

        verify(hours).sessions(LocalDateTime.parse("2026-10-29T00:00:00"),
                LocalDateTime.parse("2026-10-30T15:00:00"));
    }

    @Test
    void averagesOverCalendarDaysNotOverDaysThatHaveData() {
        // Of the last 7 full days (10-23 ... 10-29) only two have data: 3 devices on 10-23, 4 on 10-29. The mean must be 7/7=1.0, not 7/2=3.5
        List<ActivitySessionRow> twoDays = new ArrayList<>(bucket("2026-10-23T09:00:00", 3, 0));
        twoDays.addAll(bucket("2026-10-29T09:00:00", 2, 2));
        when(hours.sessions(LocalDateTime.parse("2026-10-23T00:00:00"), TODAY_START)).thenReturn(twoDays);

        assertEquals(1.0, stats.active("day", 1).totals().avg7(), 0.001);
    }

    @Test
    void sevenDayAverageLeavesOutTodayBecauseItIsNotOverYet() {
        // Today is only half over; counting it in the denominator would make the morning mean visibly low; the window is the 7 full days ending yesterday, today exclusive
        when(hours.sessions(LocalDateTime.parse("2026-10-23T00:00:00"), TODAY_START))
                .thenReturn(bucket("2026-10-29T09:00:00", 7, 0));
        when(hours.sessions(TODAY_START, TOMORROW_START)).thenReturn(bucket("2026-10-30T09:00:00", 70, 0));

        assertEquals(1.0, stats.active("day", 1).totals().avg7(), 0.001, "Today's 70 devices aren't in the mean");
    }

    @Test
    void aSessionOverMidnightCountsOnBothDaysAndEveryHourItCovers() {
        when(hours.sessions(any(), any())).thenReturn(List.of(
                session("mac", "u_a", "2026-10-28T22:30:00", "2026-10-29T01:10:00"),
                session("mac", "u_b", "2026-10-29T00:30:00", "2026-10-29T00:40:00")));

        List<ActiveView.Point> days = stats.active("day", 3).points();
        assertEquals(1, days.get(0).total(), "10-28");
        assertEquals(1, days.get(1).total(), "On 10-29 one device with two accounts counts as one device");
        assertEquals(2, days.get(1).users(), "Both users count");
        assertEquals(0, days.get(2).total());

        List<ActiveView.Point> hourly = stats.active("hour", 3).points();
        assertEquals(List.of("2026-10-28T22:00:00", "2026-10-28T23:00:00", "2026-10-29T00:00:00", "2026-10-29T01:00:00"),
                hourly.stream().filter(point -> point.total() > 0).map(ActiveView.Point::bucket).toList());
    }

    @Test
    void reconnectsOfTheSameDeviceAreDeduplicatedPerBucket() {
        when(hours.sessions(any(), any())).thenReturn(List.of(
            session("mac", "u_a", "2026-10-29T09:00:00", "2026-10-29T09:05:00"),
            session("mac", "u_a", "2026-10-29T09:10:00", "2026-10-29T09:20:00")));
        var day = stats.active("day", 2).points().getFirst();
        assertEquals(1, day.total());
        assertEquals(1, day.users());
    }

    @Test
    void activeHoursAreSummedDurationsNotBucketCounts() {
        when(hours.sessions(any(), any())).thenReturn(List.of(
                session("mac", "u_a", "2026-10-30T09:00:00", "2026-10-30T10:30:00"),
                session("mac", "u_b", "2026-10-30T10:00:00", "2026-10-30T11:00:00"),
                session("phone", "u_a", "2026-10-30T09:00:00", "2026-10-30T09:30:00"),
                session("mac", "u_a", "2026-10-29T23:00:00", "2026-10-30T01:00:00")));
        when(activeMemberNames.deviceNames(any())).thenReturn(List.of());
        when(activeMemberNames.userNames(any())).thenReturn(List.of());
        var service = new OpsStatsService(users, devices, hours, CLOCK, activeMemberNames);

        var terminals = service.activeMembers("terminals", "today", "", "day", "all", 1, 20).members().items();
        var mac = terminals.stream().filter(member -> member.memberId().equals("mac")).findFirst().orElseThrow();
        assertEquals(3.0, mac.activeHours(), 0.001, "Today 00:00-01:00 plus 09:00-11:00; overlaps on the same device aren't double-counted, and yesterday's part doesn't count");
        assertEquals(LocalDateTime.parse("2026-10-30T11:00:00"), mac.lastActiveAt());

        var people = service.activeMembers("users", "today", "", "day", "all", 1, 20).members().items();
        var alice = people.stream().filter(member -> member.memberId().equals("u_a")).findFirst().orElseThrow();
        assertEquals(3.0, alice.activeHours(), 0.001, "Sum of online duration across devices: the phone's half hour counts too");
        assertEquals(2, alice.terminalCount());
        var bob = people.stream().filter(member -> member.memberId().equals("u_b")).findFirst().orElseThrow();
        assertEquals(1.0, bob.activeHours(), 0.001, "One device counts toward two accounts at once");
    }

    @Test
    void onlineSessionAcrossMidnightCountsOnBothDays() {
        when(hours.sessions(any(), any())).thenReturn(List.of(session("phone", "u_a", "2026-10-29T23:30:00", "2026-10-30T00:30:00")));
        when(activeMemberNames.deviceNames(any())).thenReturn(List.of());
        when(activeMemberNames.userNames(any())).thenReturn(List.of());
        var service = new OpsStatsService(users, devices, hours, CLOCK, activeMemberNames);

        for (String day : List.of("yesterday", "today")) {
            var phone = service.activeMembers("terminals", day, "", "day", "all", 1, 20).members().items().get(0);
            assertEquals("phone", phone.memberId());
            assertEquals(0.5, phone.activeHours(), 0.001, day);
        }
    }

    @Test
    void hoursAreEmptyNotZeroWithoutSessionsAndLastActiveStaysInsideTheRange() {
        when(hours.sessions(any(), any())).thenReturn(List.of(session("mac", "u_a", "2026-10-29T23:00:00", "2026-10-30T01:00:00")));
        when(activeMemberNames.deviceNames(any())).thenReturn(List.of());
        when(activeMemberNames.userNames(any())).thenReturn(List.of());
        var service = new OpsStatsService(users, devices, hours, CLOCK, activeMemberNames);

        var items = service.activeMembers("terminals", "yesterday", "", "day", "all", 1, 20).members().items();

        assertEquals(LocalDateTime.parse("2026-10-30T00:00:00").minusNanos(1), items.get(0).lastActiveAt(), "For a session running into today, yesterday's latest activity doesn't go past yesterday");
        assertEquals(1.0, items.get(0).activeHours(), 0.001);
        assertEquals(1, items.size(), "Only devices confirmed online are counted");
        assertEquals(0, service.activeMembers("terminals", "yesterday", "", "day", "standalone", 1, 20).members().total());
    }

    @Test
    void deviceListShowsEveryLinkedAccountEvenWhenFilteredByOne() {
        OpsDeviceRow mac = new OpsDeviceRow();
        mac.setDeviceUuid("ABC");
        mac.setAppVersion("0.11.0");
        when(devices.searchDevices(any(), anyBoolean(), any(), any(), any(), any(), anyInt(), anyInt())).thenReturn(List.of(mac));
        OpsDeviceAccountRow alice = new OpsDeviceAccountRow();
        alice.setDeviceUuid("abc");
        alice.setUserId("u_a");
        OpsDeviceAccountRow bob = new OpsDeviceAccountRow();
        bob.setDeviceUuid("abc");
        bob.setUserId("u_b");
        when(devices.accountsOf(any(), any())).thenReturn(List.of(alice, bob));

        var row = stats.devices(null, "terminal", "u_b", false, 1, 20).items().get(0);

        assertEquals(List.of("u_a", "u_b"), row.accounts().stream().map(DeviceView.Account::userId).toList(), "Matches despite different case");
        assertEquals("0.11.0", row.appVersion());
        verify(devices).countDevices(null, true, null, "u_b", null);
    }

    @Test
    void aHugePageNumberIsABadRequestNotAnIntOverflowInTheSql() {
        // (20000000-1)*200 exceeds the int limit; old code overflowed to a negative offset, MySQL reported a syntax error, ending in a 500
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.users(null, 20_000_000, 200)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.devices(null, "all", null, false, 20_000_000, 200)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.devices(null, "terminal", null, false, Integer.MAX_VALUE, 2)));
        org.mockito.Mockito.verifyNoInteractions(users, devices);

        stats.users(null, 10_000_001, 200);
        verify(users).searchUsers(eq(null), any(), any(), eq(2_000_000_000), eq(200));
    }

    @Test
    void activityWindowsUseTheirOwnBoundaries() {
        // Pick a mid-month day: 29 days before 10-30 is exactly 10-01, which would coincide completely with the "current calendar month" window,
        // and then you couldn't tell which bound each metric used
        statsAt(shanghai("2026-10-15T14:15:00")).summary();

        verify(hours).countActiveDevices(dayStart("2026-10-15"), dayStart("2026-10-16"));  // today
        verify(hours).countActiveDevices(dayStart("2026-10-14"), dayStart("2026-10-15"));  // yesterday
        verify(hours).countActiveDevices(dayStart("2026-09-16"), dayStart("2026-10-16"));  // last 30 days including today
        verify(hours).countActiveDevices(dayStart("2026-10-01"), dayStart("2026-10-16"));  // current calendar month
    }

    @Test
    void mauMonthStartsOnTheFirstEvenLateInTheMonth() {
        statsAt(shanghai("2026-10-28T23:30:00")).summary();

        verify(hours).countActiveDevices(dayStart("2026-10-01"), dayStart("2026-10-29"));
        verify(hours).countActiveDevices(dayStart("2026-09-29"), dayStart("2026-10-29"));
    }

    @Test
    void rejectsOutOfRangeRangesInsteadOfScanningTheWholeTable() {
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.active("day", 0)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.active("day", 91)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.active("hour", 8)), "The hourly view allows at most 7 days");
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.active("week", 7)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.devices(null, "nodes", null, false, 1, 20)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.users(null, 0, 20)));
        assertEquals(OpsError.BAD_REQUEST, codeOf(() -> stats.users(null, 1, 201)));
    }

    @Test
    void defaultsToDayGranularityAndAllScope() {
        assertEquals("day", stats.active(null, 7).granularity());
        assertEquals("day", stats.active("  DAY ", 7).granularity());
        stats.devices(null, null, null, false, 1, 20);
        verify(devices).countDevices(null, false, null, null, null);
    }

    @Test
    void splitsCommaSeparatedAgentsAndTreatsBlankAsEmpty() {
        assertEquals(List.of("codex", "qoder"), OpsStatsService.splitAgents("codex,qoder"));
        assertEquals(List.of("codex"), OpsStatsService.splitAgents(" codex , "));
        assertEquals(List.of(), OpsStatsService.splitAgents(null));
        assertEquals(List.of(), OpsStatsService.splitAgents("  "));
    }

    @Test
    void summaryReadsCountsFromTheirOwnTables() {
        when(users.countRealUsers()).thenReturn(12L);
        when(devices.countAllDevices()).thenReturn(9L);
        when(devices.countAllTerminals()).thenReturn(8L);
        when(devices.countOnlineTerminals(any())).thenReturn(3L);
        when(hours.earliestStatHour()).thenReturn(null);

        SummaryView summary = stats.summary();

        assertEquals(12L, summary.userCount(), "Registered users count only real people, not Agents");
        assertEquals(9L, summary.deviceCount(), "The device count comes from the devices table, including standalone ones without an account");
        assertEquals(8L, summary.terminalCount());
        assertEquals(3L, summary.onlineTerminalCount());
        assertEquals(0L, summary.dauToday());
        assertNull(summary.earliestStatHour(), "null when there's no data yet, so the frontend shows a hint instead of treating 0 as a real number");
        assertEquals(List.of(), summary.unavailable(), "All four blocks were read");
        assertEquals(LocalDateTime.now(CLOCK), summary.generatedAt());
    }

    @Test
    void summaryKeepsTheOtherBlocksWhenTheHourTableIsUnreadable() {
        when(users.countRealUsers()).thenReturn(12L);
        when(devices.countAllDevices()).thenReturn(9L);
        when(devices.countAllTerminals()).thenReturn(8L);
        when(devices.countOnlineTerminals(any())).thenReturn(3L);
        when(hours.countActiveDevices(any(), any())).thenThrow(HOUR_TABLE_MISSING);
        when(hours.earliestStatHour()).thenThrow(HOUR_TABLE_MISSING);

        SummaryView summary = stats.summary();

        assertEquals(12L, summary.userCount(), "A missing summary table must not take the registered user count down with it");
        assertEquals(9L, summary.deviceCount());
        assertEquals(8L, summary.terminalCount());
        assertEquals(3L, summary.onlineTerminalCount());
        assertNull(summary.dauToday());
        assertNull(summary.dauYesterday());
        assertNull(summary.mau30());
        assertNull(summary.mauMonth());
        assertNull(summary.earliestStatHour());
        assertEquals(List.of("active"), summary.unavailable(), "Two failed queries in the same block are recorded once");
    }

    @Test
    void summaryMarksEachUnreadableBlockAndStillReturnsTheRest() {
        when(users.countRealUsers()).thenThrow(USERS_UNREADABLE);
        when(devices.countAllDevices()).thenReturn(9L);
        when(devices.countAllTerminals()).thenThrow(TERMINALS_MISSING);
        when(devices.countOnlineTerminals(any())).thenThrow(TERMINALS_MISSING);
        when(hours.countActiveDevices(any(), any())).thenReturn(2L);
        when(hours.earliestStatHour()).thenReturn(LocalDateTime.parse("2026-10-30T00:00:00"));

        SummaryView summary = stats.summary();

        assertNull(summary.userCount());
        assertEquals(9L, summary.deviceCount(), "The device count is a separate block and is returned as usual");
        assertNull(summary.terminalCount());
        assertNull(summary.onlineTerminalCount());
        assertEquals(2L, summary.dauToday(), "The activity summary is returned as usual too");
        assertEquals(List.of("account", "terminal"), summary.unavailable(), "Broken blocks are listed in failure order");
    }

    @Test
    void searchPagesAreOffsetByPageSizeAndKeywordIsEscaped() {
        when(users.countUsers(anyString())).thenReturn(45L);
        when(users.searchUsers(anyString(), any(), any(), anyInt(), anyInt())).thenReturn(List.of());

        var page = stats.users(" 100% ", 3, 20);

        assertEquals(3, page.page());
        assertEquals(20, page.size());
        assertEquals(45, page.total());
        // A % in the search box must be literal, otherwise a single percent sign matches the whole table
        verify(users).searchUsers(eq("%100\\%%"), any(), any(), eq(40), eq(20));
    }

    @Test
    void blankKeywordBecomesNullSoTheSqlSkipsTheFilterEntirely() {
        when(devices.searchDevices(any(), anyBoolean(), any(), any(), any(), any(), anyInt(), anyInt())).thenReturn(List.of());

        stats.devices("   ", "all", null, false, 1, 20);

        verify(devices).countDevices(null, false, null, null, null);
        verify(devices).searchDevices(eq(null), eq(false), eq(null), eq(null), eq(null), any(), eq(0), eq(20));
    }

    private static OpsError codeOf(Runnable call) {
        return assertThrows(BizException.class, call::run).error();
    }

    private OpsStatsService statsAt(Instant instant) {
        return new OpsStatsService(users, devices, hours, Clock.fixed(instant, ZoneId.of("Asia/Shanghai")));
    }

    /** Converts a Shanghai local time to an Instant so test cases don't need to compute the offset by hand */
    private static Instant shanghai(String localDateTime) {
        return LocalDateTime.parse(localDateTime).atZone(ZoneId.of("Asia/Shanghai")).toInstant();
    }

    private static LocalDateTime dayStart(String date) {
        return java.time.LocalDate.parse(date).atStartOfDay();
    }
    @Test void midnightEndIsExclusiveAndFractionalIntervalsAreSummedBeforeRounding() {
        var from = LocalDateTime.parse("2026-11-07T00:00:00");
        var to = from.plusDays(1);
        var rows = List.of(session("mac", "u_a", "2026-11-07T23:59:45", "2026-11-08T00:00:00"));
        var buckets = ActivityStats.buckets(rows, from, to.plusDays(1), false);
        assertEquals(1, buckets.size());
        assertEquals(true, buckets.containsKey("2026-11-07"));
        var fractional = List.of(
            session("mac", "u_a", "2026-11-07T10:00:00", "2026-11-07T10:00:00.600"),
            session("mac", "u_a", "2026-11-07T10:00:01", "2026-11-07T10:00:01.600"));
        assertEquals(1, ActivityStats.overlapSeconds(fractional, from, to));
    }

}
