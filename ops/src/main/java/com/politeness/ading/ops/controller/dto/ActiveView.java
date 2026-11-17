package com.politeness.ading.ops.controller.dto;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Activity trend. points already fills buckets with no active devices in the window with 0, so the frontend doesn't need to fill dates itself.
 * total is the deduplicated device count, loggedIn those with an account, standalone the standalone ones not logged in.
 */
public record ActiveView(
        String granularity,
        int days,
        List<Point> points,
        Totals totals,
        LocalDateTime earliestStatHour) {

    public record Point(String bucket, long total, long loggedIn, long standalone, long users) {
        public Point(String bucket, long total, long loggedIn, long standalone) { this(bucket, total, loggedIn, standalone, 0); }
    }

    public record Totals(long dauToday, long dauYesterday, double avg7, long mau30, long mauMonth, long dauUsersToday, long dauUsersYesterday, double avgUsers7, long mauUsers30, long mauUsersMonth) {
        public Totals(long dauToday, long dauYesterday, double avg7, long mau30, long mauMonth) { this(dauToday, dauYesterday, avg7, mau30, mauMonth, 0, 0, 0, 0, 0); }
    }
}
