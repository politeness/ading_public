package com.politeness.ading.ops.service;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.common.PasswordVerifier;
import com.politeness.ading.ops.config.OpsAccountGuard;
import com.politeness.ading.ops.controller.dto.OpsSessionView;
import com.politeness.ading.ops.dal.OpsAccountRow;
import com.politeness.ading.ops.dal.mapper.OpsUserMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

/**
 * Ops console login: uses existing ADing account credentials, then checks whether the account is on the ops list.
 */
@Slf4j
@Service
public class OpsAuthService {

    private static final String STATUS_ACTIVE = "ACTIVE";

    private final OpsUserMapper users;
    private final PasswordVerifier passwords;
    private final OpsAccountGuard guard;
    private final OpsTokenService tokens;
    private final LoginThrottle throttle;
    private final VerificationGate gate;

    public OpsAuthService(OpsUserMapper users, PasswordVerifier passwords, OpsAccountGuard guard,
                          OpsTokenService tokens, LoginThrottle throttle, VerificationGate gate) {
        this.users = users;
        this.passwords = passwords;
        this.guard = guard;
        this.tokens = tokens;
        this.throttle = throttle;
        this.gate = gate;
    }

    /** Returns a session token on successful login; any failure throws BizException, which the controller turns into an error response outside the cookie. */
    public LoginResult login(String username, String password, String ip) {
        // Pass the verification gate first: if no slot is available, return "try again later" without consuming this IP's attempts
        if (!gate.tryEnter()) {
            throw new BizException(OpsError.LOGIN_BUSY);
        }
        try {
            return verify(username, password, ip);
        } finally {
            gate.leave();
        }
    }

    private LoginResult verify(String username, String password, String ip) {
        // Atomically take an attempt slot before verifying the password, so concurrent requests can't squeeze past the check together; see LoginThrottle
        if (!throttle.tryAcquire(ip)) {
            throw new BizException(OpsError.TOO_MANY_TRIES);
        }
        String name = username == null ? "" : username.trim();
        // Never compare against the real hash of an account not on the list: otherwise the ops console becomes a password checker for every account on the site,
        // and hitting this public endpoint with any username and password would confirm whether a set of ADing credentials is valid.
        // But not-on-list, account missing, Agent, and wrong password must all return the same error code and take the same time:
        // query the database anyway, compute PBKDF2 anyway (matches computes a decoy when there is no hash to compare),
        // otherwise error codes or response times would enumerate the ops accounts for a focused brute-force.
        OpsAccountRow account = users.findAccountByUsername(name);
        boolean eligible = guard.isOpsUser(name) && account != null
                && !Boolean.TRUE.equals(account.getIsAgent());
        boolean matched = passwords.matches(password, eligible ? account.getPassword() : null);
        if (!eligible || !matched) {
            throw new BizException(OpsError.BAD_CREDENTIALS);
        }
        // Only tell the caller the account is disabled once the password is correct, when they have proven they own the account
        if (!STATUS_ACTIVE.equals(account.getStatus())) {
            throw new BizException(OpsError.ACCOUNT_DISABLED);
        }
        throttle.recordSuccess(ip);
        int epoch = account.getTokenEpoch() == null ? 0 : account.getTokenEpoch();
        String token = tokens.issue(account.getUserId(), account.getUsername(), epoch);
        log.info("Ops console login succeeded username={} ip={}", account.getUsername(), ip);
        return new LoginResult(token, new OpsSessionView(
                account.getUsername(), account.getDisplayName(), account.getUserId(), tokens.expiresAt(),
                zone()));
    }

    /** Time zone for displaying times on the page; the same one used for token expiry and statistics day cuts */
    public String zone() {
        return tokens.zone().getId();
    }

    public record LoginResult(String token, OpsSessionView view) {
    }
}
