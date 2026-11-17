package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.ProfileError;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The logged-in account's own profile: nickname, avatar, phone number, email.
 *
 * Validation rules and messages match desktop src/store/profile-patch.ts —
 * editing the profile in standalone and online versions must show the same limits.
 */
@Service
public class ProfileService {

    static final int MAX_DISPLAY_NAME = 30;
    static final int MAX_AVATAR = 1_400_000;
    static final int MAX_PHONE = 30;
    static final int MAX_EMAIL = 254;

    private final UserMapper userMapper;

    public ProfileService(UserMapper userMapper) {
        this.userMapper = userMapper;
    }

    public UserEntity get(String userId) {
        UserEntity user = userMapper.findByUserId(userId);
        if (user == null || Boolean.TRUE.equals(user.getIsAgent())) {
            throw new BizException(ProfileError.USER_NOT_FOUND);
        }
        return user;
    }

    /**
     * null means this field is unchanged; an empty string for avatar, phone or email means clear it.
     * All fields are validated first: if any is invalid, the whole update takes no effect, nothing half-applied.
     */
    @Transactional
    public UserEntity update(String userId, String displayName, String avatarUrl,
                             String phone, String email) {
        UserEntity user = get(userId);
        String nextName = displayName == null ? user.getDisplayName() : normalizeDisplayName(displayName);
        String nextAvatar = avatarUrl == null ? user.getAvatarUrl() : normalizeAvatarUrl(avatarUrl);
        String nextPhone = phone == null ? user.getPhone() : normalizePhone(phone);
        String nextEmail = email == null ? user.getEmail() : normalizeEmail(email);

        user.setDisplayName(nextName);
        user.setAvatarUrl(nextAvatar);
        user.setPhone(nextPhone);
        user.setEmail(nextEmail);
        userMapper.updateProfile(user);
        return user;
    }

    static String normalizeDisplayName(String value) {
        String name = value.trim();
        if (name.isEmpty()) {
            throw new BizException(ProfileError.DISPLAY_NAME_BLANK);
        }
        if (name.length() > MAX_DISPLAY_NAME) {
            throw new BizException(ProfileError.DISPLAY_NAME_TOO_LONG);
        }
        return name;
    }

    static String normalizeAvatarUrl(String value) {
        if (!value.isEmpty() && !value.startsWith("data:image/")) {
            throw new BizException(ProfileError.BAD_AVATAR);
        }
        if (value.length() > MAX_AVATAR) {
            throw new BizException(ProfileError.AVATAR_TOO_LARGE);
        }
        return value.isEmpty() ? null : value;
    }

    static String normalizePhone(String value) {
        String phone = value.trim();
        if (phone.length() > MAX_PHONE) {
            throw new BizException(ProfileError.PHONE_TOO_LONG);
        }
        return phone.isEmpty() ? null : phone;
    }

    static String normalizeEmail(String value) {
        String email = value.trim();
        if (email.length() > MAX_EMAIL) {
            throw new BizException(ProfileError.EMAIL_TOO_LONG);
        }
        return email.isEmpty() ? null : email;
    }
}
