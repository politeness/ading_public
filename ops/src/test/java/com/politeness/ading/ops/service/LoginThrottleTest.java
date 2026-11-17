package com.politeness.ading.ops.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.politeness.ading.ops.config.OpsProperties;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;

class LoginThrottleTest {

    private final AtomicLong millis = new AtomicLong(Instant.parse("2026-10-30T06:00:00Z").toEpochMilli());
    private final Clock clock = new Clock() {
        @Override public ZoneId getZone() { return ZoneId.of("UTC"); }
        @Override public Clock withZone(ZoneId zone) { return this; }
        @Override public Instant instant() { return Instant.ofEpochMilli(millis.get()); }
    };
    private final OpsProperties properties = new OpsProperties();
    private final LoginThrottle throttle = new LoginThrottle(properties, clock);

    private int grantedOf(String ip, int tries) {
        int granted = 0;
        for (int i = 0; i < tries; i++) {
            if (throttle.tryAcquire(ip)) {
                granted++;
            }
        }
        return granted;
    }

    @Test
    void grantsTheConfiguredNumberOfAttemptsThenBlocks() {
        assertEquals(5, properties.getLoginMaxFailures());
        for (int i = 0; i < 5; i++) {
            assertTrue(throttle.tryAcquire("1.2.3.4"), "Attempt " + (i + 1) + " is still within the quota");
        }
        assertFalse(throttle.tryAcquire("1.2.3.4"), "After five are used up, the sixth doesn't even verify the password");
    }

    @Test
    void concurrentRequestsCannotAllSlipPastTheCheck() throws Exception {
        // The old implementation checked first and recorded failure only after verifying: 40 concurrent requests would all pass the check. Slots are now taken atomically
        int threads = 40;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        try {
            CountDownLatch start = new CountDownLatch(1);
            List<Future<Boolean>> results = new ArrayList<>();
            for (int i = 0; i < threads; i++) {
                results.add(pool.submit(() -> {
                    start.await();
                    return throttle.tryAcquire("9.9.9.9");
                }));
            }
            start.countDown();
            int granted = 0;
            for (Future<Boolean> result : results) {
                if (result.get(10, TimeUnit.SECONDS)) {
                    granted++;
                }
            }
            assertEquals(5, granted, "Even at full concurrency only loginMaxFailures get through");
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void blockLiftsItselfAfterTheBlockWindow() {
        grantedOf("1.2.3.4", 5);
        assertFalse(throttle.tryAcquire("1.2.3.4"));
        millis.addAndGet(properties.getLoginBlockMinutes() * 60_000L + 1);
        assertEquals(5, grantedOf("1.2.3.4", 6), "After the lockout period it opens automatically and the quota resets");
    }

    @Test
    void attemptsOutsideTheWindowDoNotAddUp() {
        grantedOf("1.2.3.4", 4);
        millis.addAndGet(properties.getLoginWindowMinutes() * 60_000L + 1);
        assertEquals(5, grantedOf("1.2.3.4", 6), "Old attempts outside the window don't accumulate, otherwise a normal user with a few typos would be locked out");
    }

    @Test
    void successClearsTheCounterEvenOnTheLastGrantedAttempt() {
        grantedOf("1.2.3.4", 5);
        throttle.recordSuccess("1.2.3.4");
        assertEquals(5, grantedOf("1.2.3.4", 6), "A successful fifth login also lifts the lockout and clears previous attempts");
    }

    @Test
    void countsPerIpSoOneAbuserDoesNotLockEveryoneOut() {
        grantedOf("1.2.3.4", 6);
        assertFalse(throttle.tryAcquire("1.2.3.4"));
        assertTrue(throttle.tryAcquire("5.6.7.8"));
    }

    @Test
    void treatsAMissingIpAsOneSharedBucket() {
        grantedOf(null, 5);
        assertFalse(throttle.tryAcquire(null));
        assertFalse(throttle.tryAcquire("  "));
    }
}
