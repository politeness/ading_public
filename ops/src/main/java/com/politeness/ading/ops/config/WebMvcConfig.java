package com.politeness.ading.ops.config;

import com.politeness.ading.ops.common.InternalTokenInterceptor;
import com.politeness.ading.ops.common.NoStoreInterceptor;
import com.politeness.ading.ops.common.OpsAuthInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class WebMvcConfig implements WebMvcConfigurer {

    private final OpsAuthInterceptor interceptor;
    private final InternalTokenInterceptor internalInterceptor;

    public WebMvcConfig(OpsAuthInterceptor interceptor, InternalTokenInterceptor internalInterceptor) {
        this.interceptor = interceptor;
        this.internalInterceptor = internalInterceptor;
    }

    @Override
    public void addInterceptors(InterceptorRegistry registry) {
        // Register no-cache first: it must run before session validation, so 401s and login responses carry it too
        registry.addInterceptor(new NoStoreInterceptor()).addPathPatterns("/api/**");
        // Paths are relative to the context-path (/ading/ops); the login endpoint itself obviously can't require being logged in
        registry.addInterceptor(interceptor)
                .addPathPatterns("/api/**")
                .excludePathPatterns("/api/login", "/api/internal/**");
        registry.addInterceptor(internalInterceptor).addPathPatterns("/api/internal/**");
    }
}
