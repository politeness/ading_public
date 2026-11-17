package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.controller.dto.ProfileUpdateRequest;
import com.politeness.ading.conductor.controller.dto.ProfileView;
import com.politeness.ading.conductor.service.ProfileService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** The logged-in account's own profile: nickname, avatar, phone number, email */
@RestController
@RequestMapping("/api/v1/profile")
public class ProfileController {

    private final ProfileService profileService;

    public ProfileController(ProfileService profileService) {
        this.profileService = profileService;
    }

    @GetMapping
    public Result<ProfileView> get() {
        return Result.ok(ProfileView.from(profileService.get(AuthContext.get().userId())));
    }

    @PutMapping
    public Result<ProfileView> update(@RequestBody ProfileUpdateRequest request) {
        return Result.ok(ProfileView.from(profileService.update(AuthContext.get().userId(),
                request.displayName(), request.avatarUrl(), request.phone(), request.email())));
    }
}
