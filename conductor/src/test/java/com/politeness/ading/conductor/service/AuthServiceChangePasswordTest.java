package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.common.PasswordEncoder;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import org.junit.jupiter.api.Test;

/** Changing the password must verify the old one first: a leaked token must not be enough to take over the account */
class AuthServiceChangePasswordTest {

    private final UserMapper userMapper = mock(UserMapper.class);
    private final PasswordEncoder passwordEncoder = new PasswordEncoder();
    private final AuthService service = new AuthService(
            userMapper, passwordEncoder, mock(TokenService.class), mock(IdGenerator.class),
            mock(com.politeness.ading.conductor.dal.mapper.PushDeviceMapper.class));

    private UserEntity me(String rawPassword) {
        UserEntity user = new UserEntity();
        user.setUserId("u_me");
        user.setIsAgent(false);
        user.setPassword(passwordEncoder.encode(rawPassword));
        when(userMapper.findByUserId("u_me")).thenReturn(user);
        return user;
    }

    @Test
    void changesOnlyWithCorrectOldPassword() {
        UserEntity user = me("old-secret");
        service.changePassword("u_me", "old-secret", "new-secret");
        assertTrue(passwordEncoder.matches("new-secret", user.getPassword()));
        verify(userMapper).updatePassword(user);
    }

    @Test
    void doesNotChangeWithWrongOldPassword() {
        UserEntity user = me("old-secret");
        assertEquals("AUTH_002", codeOf(() -> service.changePassword("u_me", "wrong", "new-secret")));
        assertTrue(passwordEncoder.matches("old-secret", user.getPassword()));
        verify(userMapper, never()).updatePassword(user);
    }

    @Test
    void newPasswordMustDifferFromOld() {
        me("old-secret");
        assertEquals("AUTH_008", codeOf(() -> service.changePassword("u_me", "old-secret", "old-secret")));
    }

    @Test
    void missingAccountOrAgentTreatedAsBadCredentials() {
        when(userMapper.findByUserId("u_missing")).thenReturn(null);
        assertEquals("AUTH_002", codeOf(() -> service.changePassword("u_missing", "x", "y")));

        UserEntity agent = new UserEntity();
        agent.setUserId("u_agent");
        agent.setIsAgent(true);
        agent.setPassword(passwordEncoder.encode("x"));
        when(userMapper.findByUserId("u_agent")).thenReturn(agent);
        assertEquals("AUTH_002", codeOf(() -> service.changePassword("u_agent", "x", "y")));
    }

    private String codeOf(Runnable action) {
        try {
            action.run();
            throw new AssertionError("Expected BizException");
        } catch (BizException e) {
            return e.getError().code();
        }
    }
}
