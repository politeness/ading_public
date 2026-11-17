package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.common.PasswordEncoder;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.common.auth.TokenType;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.AuthError;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {


    private final UserMapper userMapper;
    private final com.politeness.ading.conductor.dal.mapper.PushDeviceMapper pushDevices;
    private final PasswordEncoder passwordEncoder;
    private final TokenService tokenService;
    private final IdGenerator idGenerator;

    public AuthService(UserMapper userMapper, PasswordEncoder passwordEncoder,
                       TokenService tokenService, IdGenerator idGenerator,
                       com.politeness.ading.conductor.dal.mapper.PushDeviceMapper pushDevices) {
        this.pushDevices = pushDevices;
        this.userMapper = userMapper;
        this.passwordEncoder = passwordEncoder;
        this.tokenService = tokenService;
        this.idGenerator = idGenerator;
    }

    @Transactional
    public UserEntity register(String username, String rawPassword, String displayName) {
        if (userMapper.countByUsername(username) > 0) {
            throw new BizException(AuthError.USERNAME_TAKEN);
        }
        UserEntity user = new UserEntity();
        user.setUserId(idGenerator.userId());
        user.setUsername(username);
        user.setDisplayName(displayName == null || displayName.isBlank() ? username : displayName);
        user.setIsAgent(false);
        user.setPassword(passwordEncoder.encode(rawPassword));
        user.setStatus(UserEntity.STATUS_ACTIVE);
        try {
            userMapper.insert(user);
        } catch (DuplicateKeyException e) {
            throw new BizException(AuthError.USERNAME_TAKEN);
        }
        return user;
    }

    public UserEntity login(String username, String rawPassword) {
        UserEntity user = userMapper.findByUsername(username);
        if (user == null || Boolean.TRUE.equals(user.getIsAgent())) {
            throw new BizException(AuthError.BAD_CREDENTIALS);
        }
        if (!UserEntity.STATUS_ACTIVE.equals(user.getStatus())) {
            throw new BizException(AuthError.ACCOUNT_DISABLED);
        }
        if (!passwordEncoder.matches(rawPassword, user.getPassword())) {
            throw new BizException(AuthError.BAD_CREDENTIALS);
        }
        return user;
    }

    /**
     * Change the user's own password. The old password must be verified first: a leaked token must not be enough to lock the account away.
     *
     * After the change, **all previously issued tokens are invalidated immediately**: updatePassword increments users.token_epoch,
     * and old tokens with a smaller epoch than the database are rejected at the auth entry (see auth/TokenEpochGuard).
     * Someone else having obtained the password is a common reason for changing it, and refresh tokens last 30 days and computer tokens a year,
     * so just waiting for expiry would make the change pointless.
     *
     * Returns the updated user, from which the caller issues new tokens — the device that changed the password keeps working with new tokens
     * and the user isn't kicked out themselves.
     */
    @Transactional
    public UserEntity changePassword(String userId, String currentPassword, String newPassword) {
        UserEntity user = userMapper.findByUserId(userId);
        if (user == null || Boolean.TRUE.equals(user.getIsAgent())) {
            throw new BizException(AuthError.BAD_CREDENTIALS);
        }
        if (!passwordEncoder.matches(currentPassword, user.getPassword())) {
            throw new BizException(AuthError.BAD_CREDENTIALS);
        }
        if (passwordEncoder.matches(newPassword, user.getPassword())) {
            throw new BizException(AuthError.SAME_PASSWORD);
        }
        user.setPassword(passwordEncoder.encode(newPassword));
        userMapper.updatePassword(user);
        // Once old tokens are invalid, phones can't unregister themselves. The phone that changed the password re-reports when it next comes to the foreground
        pushDevices.deleteByOwner(userId);
        // The epoch is incremented in SQL, so re-read to get the new value
        return userMapper.findByUserId(userId);
    }

    /** Exchange a refresh token for a new token pair */
    public UserEntity refresh(String refreshToken) {
        TokenService.Claims claims = tokenService.parse(refreshToken);
        if (claims.type() != TokenType.REFRESH) {
            throw new BizException(AuthError.WRONG_TOKEN_TYPE);
        }
        UserEntity user = userMapper.findByUserId(claims.subject());
        if (user == null) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        // Refresh tokens bypass the auth interceptor (this is a login-free path), so the epoch must be checked here
        if (user.getTokenEpoch() == null || user.getTokenEpoch() != claims.epoch()) {
            throw new BizException(AuthError.TOKEN_REVOKED);
        }
        if (!UserEntity.STATUS_ACTIVE.equals(user.getStatus())) {
            throw new BizException(AuthError.ACCOUNT_DISABLED);
        }
        return user;
    }

    public UserEntity requireUser(String userId) {
        UserEntity user = userMapper.findByUserId(userId);
        if (user == null) {
            throw new BizException(AuthError.TOKEN_INVALID);
        }
        return user;
    }
}
