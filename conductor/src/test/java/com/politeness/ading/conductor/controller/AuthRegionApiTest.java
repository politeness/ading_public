package com.politeness.ading.conductor.controller;

import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.reset;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.politeness.ading.conductor.common.auth.AuthInterceptor;
import com.politeness.ading.conductor.common.auth.TokenEpochGuard;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.common.config.WebMvcConfig;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.service.AuthService;
import com.politeness.ading.conductor.service.IpCityResolver;
import com.politeness.ading.conductor.service.RegionPolicy;
import com.politeness.ading.conductor.service.RelationService;
import com.politeness.ading.conductor.service.AgentService;
import com.politeness.ading.conductor.service.AgentStateService;
import com.politeness.ading.conductor.service.UserReportService;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.context.ContextConfiguration;
import org.springframework.test.context.TestPropertySource;
import org.springframework.test.context.junit.jupiter.SpringExtension;
import org.springframework.test.context.web.WebAppConfiguration;
import com.politeness.ading.conductor.dal.mapper.UserTagMapper;
import com.politeness.ading.conductor.service.UserTags;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.context.WebApplicationContext;
import org.springframework.web.servlet.config.annotation.EnableWebMvc;
import tools.jackson.databind.ObjectMapper;

/**
 * All regions may register, sign in and go online; the backend returns the client's add-friend permission based on IP and the original allowlist.
 * The real address database decides mainland / Hong Kong, Macao and Taiwan; the client IP is set directly on the connection address.
 */
@ExtendWith(SpringExtension.class)
@WebAppConfiguration
@ContextConfiguration(classes = AuthRegionApiTest.WebLayer.class)
// The switch left over from old deployments no longer blocks mainland accounts from going online.
@TestPropertySource(properties = "ading.region.block-mainland=true")
class AuthRegionApiTest {

    /** Shanghai (Alibaba Cloud public address) */
    private static final String MAINLAND = "223.5.5.5";
    private static final String HONG_KONG = "203.198.0.1";
    private static final String MACAU = "202.175.3.3";
    private static final String TAIWAN = "168.95.1.1";

    @EnableWebMvc
    @Configuration
    @Import({AuthController.class, FriendController.class, GlobalExceptionHandler.class, WebMvcConfig.class,
            AuthInterceptor.class, TokenService.class, TokenEpochGuard.class,
            RegionPolicy.class, IpCityResolver.class})
    static class WebLayer {
        @Bean
        AdingProperties adingProperties() {
            AdingProperties properties = new AdingProperties();
            properties.getAuth().setSecret("unit-test-secret-that-is-long-enough-32+");
            return properties;
        }

        @Bean
        ObjectMapper objectMapper() {
            return new ObjectMapper();
        }

        @Bean
        UserMapper userMapper() {
            return Mockito.mock(UserMapper.class);
        }

        @Bean
        UserTagMapper userTagMapper() {
            UserTagMapper tags = Mockito.mock(UserTagMapper.class);
            for (String userId : new String[] {"u_dev", "u_reviewer"}) {
                when(tags.hasTag(userId, UserTags.MAINLAND_ADD_FRIEND)).thenReturn(true);
            }

            return tags;
        }

        @Bean
        com.politeness.ading.conductor.dal.mapper.OnboardingMapper onboardingMapper() {
            var mapper = Mockito.mock(com.politeness.ading.conductor.dal.mapper.OnboardingMapper.class);
            when(mapper.steps("u_existing")).thenReturn(255);
            return mapper;
        }

        @Bean
        RelationService relationService() { return Mockito.mock(RelationService.class); }
        @Bean
        AgentService agentService() { return Mockito.mock(AgentService.class); }
        @Bean
        AgentStateService agentStateService() { return Mockito.mock(AgentStateService.class); }
        @Bean
        UserReportService userReportService() { return Mockito.mock(UserReportService.class); }

        @Bean
        AuthService authService() {
            return Mockito.mock(AuthService.class);
        }
    }

    @Autowired
    private WebApplicationContext context;
    @Autowired
    private AuthService authService;
    @Autowired
    private UserMapper userMapper;
    @Autowired
    private TokenService tokenService;
    @Autowired
    private RelationService relationService;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        mockMvc = MockMvcBuilders.webAppContextSetup(context).build();
        reset(authService, userMapper, relationService);
        when(userMapper.findTokenEpoch(anyString())).thenReturn(0);
    }

    private static UserEntity user(String userId) {
        UserEntity user = new UserEntity();
        user.setUserId(userId);
        user.setUsername(userId);
        user.setIsAgent(false);
        user.setTokenEpoch(0);
        return user;
    }

    private static MockHttpServletRequestBuilder from(String ip, MockHttpServletRequestBuilder builder) {
        return builder.contentType(MediaType.APPLICATION_JSON).with(request -> {
            request.setRemoteAddr(ip);
            return request;
        });
    }

    private void login(String ip, String userId) throws Exception {
        when(authService.login(userId, "secret")).thenReturn(user(userId));
        mockMvc.perform(from(ip, post("/api/v1/auth/login"))
                        .content("{\"username\":\"" + userId + "\",\"password\":\"secret\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));
    }

    @Test
    void mainlandIpCanRegisterButClientCannotAddFriends() throws Exception {
        when(authService.register("alice", "secret", null)).thenReturn(user("u_alice"));
        mockMvc.perform(from(MAINLAND, post("/api/v1/auth/register"))
                        .content("{\"username\":\"alice\",\"password\":\"secret\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.canAddFriend").value(false));
        verify(authService).register("alice", "secret", null);
    }

    @Test
    void mainlandIpCanSignInButClientCannotAddFriends() throws Exception {
        when(authService.login("alice", "secret")).thenReturn(user("u_alice"));
        mockMvc.perform(from(MAINLAND, post("/api/v1/auth/login"))
                        .content("{\"username\":\"alice\",\"password\":\"secret\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.canAddFriend").value(false));
    }

    @Test
    void onboardingSkipsExistingAccountsAndAllowsNewAndPreviewAccounts() throws Exception {
        for (String userId : new String[] {"u_existing", "u_new", "u_preview"}) {
            boolean eligible = !userId.equals("u_existing");
            when(authService.login(userId, "secret")).thenReturn(user(userId));
            mockMvc.perform(from(MAINLAND, post("/api/v1/auth/login"))
                            .content("{\"username\":\"" + userId + "\",\"password\":\"secret\"}"))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.onboardingEligible").value(eligible));
            mockMvc.perform(from(MAINLAND, get("/api/v1/auth/region-policy"))
                            .header("Authorization", "Bearer " + tokenService.issueAccessToken(userId, 0)))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.onboardingEligible").value(eligible));
        }
    }

    @Test
    void onboardingRequiresLoginValidatesMaskAndOnlyWritesAuthenticatedUser() throws Exception {
        mockMvc.perform(get("/api/v1/auth/onboarding")).andExpect(status().isUnauthorized());
        String token = "Bearer " + tokenService.issueAccessToken("u_preview", 0);
        var mapper = context.getBean(com.politeness.ading.conductor.dal.mapper.OnboardingMapper.class);
        when(mapper.steps("u_preview")).thenReturn(3);
        mockMvc.perform(get("/api/v1/auth/onboarding").header("Authorization", token))
                .andExpect(jsonPath("$.data.completedSteps").value(3));
        mockMvc.perform(post("/api/v1/auth/onboarding").header("Authorization", token)
                .contentType(MediaType.APPLICATION_JSON).content("{\"completedSteps\":7}"))
                .andExpect(status().isOk());
        verify(mapper).acknowledge("u_preview", 7);
        mockMvc.perform(post("/api/v1/auth/onboarding").header("Authorization", token)
                .contentType(MediaType.APPLICATION_JSON).content("{\"completedSteps\":256}"))
                .andExpect(status().isBadRequest());
    }

    private void permissions(String ip, String userId, boolean allowed) throws Exception {
        mockMvc.perform(from(ip, get("/api/v1/auth/region-policy"))
                        .header("Authorization", "Bearer " + tokenService.issueAccessToken(userId, 0)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.canAddFriend").value(allowed))
                .andExpect(jsonPath("$.data.exemptUsers").doesNotExist());
    }

    @Test
    void currentIpPermissionsDistinguishMainlandHkMacaoTaiwanOverseasAndAllowlist() throws Exception {
        permissions(MAINLAND, "u_alice", false);
        permissions(MAINLAND, "u_dev", true);
        permissions(MAINLAND, "u_reviewer", true);
        for (String ip : new String[] {HONG_KONG, MACAU, TAIWAN, "8.8.8.8"}) {
            permissions(ip, "u_alice", true);
        }
        permissions("2400:3200::1", "u_alice", false);
        permissions("2400:3200::1", "u_dev", true);
        permissions("2001:4860:4860::8888", "u_alice", true);
    }

    @Test
    void mainlandIpBackendFriendApisAreAllOpen() throws Exception {
        String token = "Bearer " + tokenService.issueAccessToken("u_alice", 0);
        when(relationService.search("u_alice", "bob")).thenReturn(List.of());
        when(relationService.request("u_alice", "u_bob")).thenReturn("OUTGOING");
        mockMvc.perform(from(MAINLAND, get("/api/v1/friends/search")).param("q", "bob")
                        .header("Authorization", token)).andExpect(status().isOk());
        mockMvc.perform(from(MAINLAND, post("/api/v1/friends/requests/u_bob"))
                        .header("Authorization", token)).andExpect(status().isOk())
                .andExpect(jsonPath("$.data.relation").value("OUTGOING"));
        mockMvc.perform(from(MAINLAND, post("/api/v1/friends/requests/u_bob/accept"))
                        .header("Authorization", token)).andExpect(status().isOk());
        verify(relationService).accept("u_alice", "u_bob");
    }

    @Test
    void regionPermissionsRequireSignIn() throws Exception {
        mockMvc.perform(from(MAINLAND, get("/api/v1/auth/region-policy")))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void allowlistedAccountCanSignInFromMainland() throws Exception {
        login(MAINLAND, "u_dev");
        permissions(MAINLAND, "u_dev", true);
    }

    @Test
    void hkMacaoTaiwanIpRegisterAndSignInAreNotBlocked() throws Exception {
        for (String ip : new String[] {HONG_KONG, MACAU, TAIWAN}) {
            when(authService.register("bob", "secret", null)).thenReturn(user("u_bob"));
            mockMvc.perform(from(ip, post("/api/v1/auth/register"))
                            .content("{\"username\":\"bob\",\"password\":\"secret\"}"))
                    .andExpect(status().isOk());
            login(ip, "u_bob");
        }
    }

    /** Signed in overseas, then moved to the mainland: post-sign-in APIs like token refresh and password change still work */
    @Test
    void mainlandIpIsNotBlockedFromPostSignInApis() throws Exception {
        when(authService.refresh("refresh-token")).thenReturn(user("u_alice"));
        mockMvc.perform(from(MAINLAND, post("/api/v1/auth/refresh"))
                        .content("{\"refreshToken\":\"refresh-token\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.canAddFriend").value(false));

        when(authService.changePassword("u_alice", "old", "new")).thenReturn(user("u_alice"));
        mockMvc.perform(from(MAINLAND, post("/api/v1/auth/password"))
                        .header("Authorization", "Bearer " + tokenService.issueAccessToken("u_alice", 0))
                        .content("{\"currentPassword\":\"old\",\"newPassword\":\"new\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));
    }
}
