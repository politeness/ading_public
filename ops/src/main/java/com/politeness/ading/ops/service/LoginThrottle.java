package com.politeness.ading.ops.service;

import com.politeness.ading.ops.config.OpsProperties;
import java.time.Clock;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * Login attempt rate limiting, counted per client IP.
 *
 * The ops console is on the public internet with only one account; without rate limiting the password is handed to dictionary attacks.
 * Per IP only, not per username: counting per username lets an attacker bypass it by rotating usernames.
 * Single-instance deployment, so in-memory counting is enough; counts resetting on restart is an acceptable cost.
 *
 * It counts "attempts", not "failures": each login atomically takes a slot before verifying the password, and only success clears it.
 * If it checked first and recorded failure only after verifying, concurrent requests from the same IP would all pass the check,
 * and the attempts per round would go from the limit to the number of Tomcat threads.
 */
@Component
public class LoginThrottle {

    private record State(int attempts, long windowStart, long blockedUntil) {
    }

    private final Map<String, State> states = new ConcurrentHashMap<>();
    private final OpsProperties properties;
    private final Clock clock;

    @Autowired
    public LoginThrottle(OpsProperties properties) {
        this(properties, Clock.systemUTC());
    }

    LoginThrottle(OpsProperties properties, Clock clock) {
        this.properties = properties;
        this.clock = clock;
    }

    /**
     * Takes an attempt slot; returns false if this IP is in a lockout period and may not verify a password this time.
     * The loginMaxFailures-th attempt in the window is still let through and starts the lockout; if that login succeeds, recordSuccess lifts it.
     */
    public boolean tryAcquire(String ip) {
        long now = clock.millis();
        long windowMillis = properties.getLoginWindowMinutes() * 60_000L;
        long blockMillis = properties.getLoginBlockMinutes() * 60_000L;
        sweep(now);
        boolean[] granted = {false};
        states.compute(key(ip), (ignored, previous) -> {
            if (previous != null && previous.blockedUntil() > now) {
                return previous;
            }
            State state = previous == null || now - previous.windowStart() > windowMillis
                    || previous.blockedUntil() != 0L
                    ? new State(0, now, 0L)
                    : previous;
            granted[0] = true;
            int attempts = state.attempts() + 1;
            return attempts >= properties.getLoginMaxFailures()
                    ? new State(0, now, now + blockMillis)
                    : new State(attempts, state.windowStart(), 0L);
        });
        return granted[0];
    }

    public void recordSuccess(String ip) {
        states.remove(key(ip));
    }

    /** Also clears long-expired entries so many distinct IPs can't grow the map without bound */
    private void sweep(long now) {
        long ttl = (properties.getLoginWindowMinutes() + properties.getLoginBlockMinutes()) * 60_000L;
        states.values().removeIf(state -> now - state.windowStart() > ttl && state.blockedUntil() < now);
    }

    private static String key(String ip) {
        return ip == null || ip.isBlank() ? "unknown" : ip.trim();
    }
}
