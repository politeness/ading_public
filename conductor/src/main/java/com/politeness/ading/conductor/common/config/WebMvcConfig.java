package com.politeness.ading.conductor.common.config;

import com.politeness.ading.conductor.common.auth.AuthInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    /** Endpoints that need no login: the standalone edition uses them too */
    private static final String[] PUBLIC = {
            "/api/v1/auth/register",
            "/api/v1/auth/login",
            "/api/v1/auth/refresh",
            "/api/v1/support/config",
            "/api/v1/support/reports",
            "/api/v1/support/contacts",
            // The standalone edition also checks for updates; when a token is sent, AppUpdateController validates it itself
            "/api/v1/app/updates/check",
            // The standalone edition also reports device telemetry; when a token is sent, TelemetryController validates it itself
            "/api/v1/telemetry/foreground"
    };

    private final AuthInterceptor authInterceptor;

    public WebMvcConfig(AuthInterceptor authInterceptor) {
        this.authInterceptor = authInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // Open to all regions; region permissions are only used by the client to control the add-friend entry.
        registry.addInterceptor(authInterceptor).addPathPatterns("/api/**").excludePathPatterns(PUBLIC);
    }
}
