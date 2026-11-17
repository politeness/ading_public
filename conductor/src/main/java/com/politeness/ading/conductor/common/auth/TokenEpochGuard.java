package com.politeness.ading.conductor.common.auth;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.AuthError;
import org.springframework.stereotype.Component;

/**
 * Checks the epoch in the token against the account's current epoch.
 *
 * The token signature alone only proves "we issued this and it has not expired", not "the account has not changed its password since it was issued".
 * A password change increments users.token_epoch, so all previously issued tokens have a smaller epoch and are rejected here.
 * One extra primary-key query per request buys "after a password change, tokens in other people's hands stop working immediately".
 */
@Component
public class TokenEpochGuard {

    private final UserMapper userMapper;

    public TokenEpochGuard(UserMapper userMapper) {
        this.userMapper = userMapper;
    }

    /** Throws BizException if the epoch does not match or the account no longer exists; returns silently if it passes. */
    public void verify(TokenService.Claims claims) {
        Integer current = userMapper.findTokenEpoch(claims.subject());
        if (current == null) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        if (current != claims.epoch()) {
            throw new BizException(AuthError.TOKEN_REVOKED);
        }
    }
}
