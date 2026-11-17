package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import org.junit.jupiter.api.Test;

/** Rules match the desktop's src/store/profile-patch.ts: editing the profile on either side must hit the same limits */
class ProfileServiceTest {

    private final UserMapper userMapper = mock(UserMapper.class);
    private final ProfileService service = new ProfileService(userMapper);

    @Test
    void displayNameTrimmed_blankAndTooLongRejected() {
        assertEquals("老板", ProfileService.normalizeDisplayName("  老板  "));
        assertEquals("PROFILE_002", codeOf(() -> ProfileService.normalizeDisplayName("   ")));
        assertEquals("PROFILE_003", codeOf(() -> ProfileService.normalizeDisplayName("a".repeat(31))));
    }

    @Test
    void avatarAcceptsOnlyImageData_emptyStringClears() {
        assertNull(ProfileService.normalizeAvatarUrl(""));
        assertEquals("PROFILE_004", codeOf(() -> ProfileService.normalizeAvatarUrl("https://x/y.png")));
        assertEquals("PROFILE_005", codeOf(() -> ProfileService.normalizeAvatarUrl("data:image/png;base64," + "a".repeat(1_400_000))));
    }

    @Test
    void anyInvalidFieldRejectsWholeUpdate() {
        UserEntity me = new UserEntity();
        me.setUserId("u_me");
        me.setIsAgent(false);
        me.setDisplayName("sampleuser");
        when(userMapper.findByUserId("u_me")).thenReturn(me);

        assertThrows(BizException.class, () -> service.update("u_me", "改了名", "https://x/y.png", null, null));
        verify(userMapper, never()).updateProfile(any());
        assertEquals("sampleuser", me.getDisplayName());
    }

    @Test
    void omittedFieldsUnchanged_emptyClears() {
        UserEntity me = new UserEntity();
        me.setUserId("u_me");
        me.setIsAgent(false);
        me.setDisplayName("sampleuser");
        me.setPhone("13800138000");
        me.setEmail("boss@example.com");
        when(userMapper.findByUserId("u_me")).thenReturn(me);

        UserEntity saved = service.update("u_me", null, null, "", null);

        assertEquals("sampleuser", saved.getDisplayName());
        assertNull(saved.getPhone());
        assertEquals("boss@example.com", saved.getEmail());
        verify(userMapper).updateProfile(me);
    }

    private static String codeOf(Runnable action) {
        return assertThrows(BizException.class, action::run).getError().code();
    }
}
