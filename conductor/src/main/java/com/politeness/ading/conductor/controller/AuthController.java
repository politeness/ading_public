package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.ClientIp;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.controller.dto.LoginRequest;
import com.politeness.ading.conductor.controller.dto.PasswordChangeRequest;
import com.politeness.ading.conductor.controller.dto.RefreshRequest;
import com.politeness.ading.conductor.controller.dto.RegisterRequest;
import com.politeness.ading.conductor.controller.dto.TokenResponse;
import com.politeness.ading.conductor.controller.dto.UserView;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.service.AuthService;
import com.politeness.ading.conductor.service.RegionPolicy;
import com.politeness.ading.conductor.dal.mapper.OnboardingMapper;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final TokenService tokenService;
    private final RegionPolicy regionPolicy;
    private final OnboardingMapper onboarding;

    public AuthController(AuthService authService, TokenService tokenService, RegionPolicy regionPolicy, OnboardingMapper onboarding) {
        this.authService = authService;
        this.tokenService = tokenService;
        this.regionPolicy = regionPolicy;
        this.onboarding = onboarding;
    }

    @PostMapping("/register")
    public Result<TokenResponse> register(@Valid @RequestBody RegisterRequest request, HttpServletRequest http) {
        UserEntity user = authService.register(request.username(), request.password(), request.displayName());
        return Result.ok(tokensFor(user, http));
    }

    @PostMapping("/login")
    public Result<TokenResponse> login(@Valid @RequestBody LoginRequest request, HttpServletRequest http) {
        UserEntity user = authService.login(request.username(), request.password());
        return Result.ok(tokensFor(user, http));
    }

    /** When refreshing tokens, sync the client permissions for the current IP; connected mode is not restricted. */
    @PostMapping("/refresh")
    public Result<TokenResponse> refresh(@Valid @RequestBody RefreshRequest request, HttpServletRequest http) {
        UserEntity user = authService.refresh(request.refreshToken());
        return Result.ok(tokensFor(user, http));
    }

    public record OnboardingProgress(int version, int completedSteps) {}
    public record OnboardingUpdate(@Min(0) @Max(255) int completedSteps) {}

    private int steps(String userId) {
        Integer value = onboarding.steps(userId);
        return value == null ? 0 : value;
    }

    private boolean eligible(String userId) { return steps(userId) != 255; }

    @GetMapping("/onboarding")
    public Result<OnboardingProgress> onboardingProgress() {
        return Result.ok(new OnboardingProgress(1, steps(AuthContext.get().userId())));
    }

    @PostMapping("/onboarding")
    public Result<OnboardingProgress> acknowledgeOnboarding(@Valid @RequestBody OnboardingUpdate request) {
        String userId = AuthContext.get().userId();
        onboarding.acknowledge(userId, request.completedSteps());
        return Result.ok(new OnboardingProgress(1, steps(userId)));
    }

    public record RegionPermissions(boolean canAddFriend, boolean onboardingEligible) {}

    /** Login required; returns only the caller's own permissions, the allowlist is not exposed to the client. */
    @GetMapping("/region-policy")
    public Result<RegionPermissions> regionPermissions(HttpServletRequest http) {
        return Result.ok(new RegionPermissions(
                regionPolicy.canAddFriend(ClientIp.of(http), AuthContext.get().userId()),
                eligible(AuthContext.get().userId())));
    }

    /**
     * Change the caller's own password. This is not on WebMvcConfig's no-login allowlist and requires a valid token;
     * AuthService verifies the old password again, so a leaked token cannot change the password.
     */
    @PostMapping("/password")
    public Result<TokenResponse> changePassword(@Valid @RequestBody PasswordChangeRequest request, HttpServletRequest http) {
        UserEntity user = authService.changePassword(
                AuthContext.get().userId(), request.currentPassword(), request.newPassword());
        // A password change invalidates all previous tokens, including the one used to call this endpoint. A new pair is issued right here and returned,
        // so the machine that changed the password keeps working, while other devices are rejected on their next request.
        return Result.ok(tokensFor(user, http));
    }

    private TokenResponse tokensFor(UserEntity user, HttpServletRequest http) {
        int epoch = user.getTokenEpoch() == null ? 0 : user.getTokenEpoch();
        return new TokenResponse(
                tokenService.issueAccessToken(user.getUserId(), epoch),
                tokenService.issueRefreshToken(user.getUserId(), epoch),
                UserView.from(user),
                regionPolicy.canAddFriend(ClientIp.of(http), user.getUserId()),
                eligible(user.getUserId()));
    }
}
