package com.politeness.ading.ops.service;

import com.politeness.ading.ops.config.OpsProperties;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import org.springframework.stereotype.Component;

/**
 * Limits the number of concurrent password verifications.
 *
 * Each login runs a deliberately slow PBKDF2 (even nonexistent accounts compute a decoy, see PasswordVerifier),
 * while LoginThrottle only limits per IP: hitting the login endpoint from many IPs at once forces the server to compute once per request,
 * saturating the CPU of the ECS shared with production conductor. This puts a global gate on verification; requests that can't get in wait briefly,
 * and if still unable, get "try again later" directly, without consuming this IP's attempts.
 */
@Component
public class VerificationGate {

    private final Semaphore permits;
    private final long waitMillis;

    public VerificationGate(OpsProperties properties) {
        this.permits = new Semaphore(Math.max(1, properties.getLoginMaxConcurrentVerifications()), true);
        this.waitMillis = Math.max(0L, properties.getLoginVerifyWaitMillis());
    }

    /** Returns true when a slot is acquired, which must be released in finally; returns false on timeout or thread interruption */
    public boolean tryEnter() {
        try {
            return permits.tryAcquire(waitMillis, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    public void leave() {
        permits.release();
    }
}
