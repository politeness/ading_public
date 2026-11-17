package com.politeness.ading.conductor.common.config;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.env.StandardEnvironment;

/**
 * The environment is decided by profile, so the defaults in the two yml files are themselves requirements:
 * prod (ECS) uses the Alibaba Cloud internal network, dev (NAS) uses the public internet. If swapped, this must fail.
 */
class ProfileDefaultsTest {

    @Configuration
    @EnableConfigurationProperties(AdingProperties.class)
    static class Properties {
    }

    /**
     * This tests the defaults of the two yml files themselves, so system environment variables must be removed first;
     * otherwise an ADING_OSS_ENDPOINT set on the dev machine overrides the default and the test drifts with the environment.
     */
    private ApplicationContextRunner baseRunner() {
        return new ApplicationContextRunner()
                .withInitializer(context -> context.getEnvironment().getPropertySources()
                        .remove(StandardEnvironment.SYSTEM_ENVIRONMENT_PROPERTY_SOURCE_NAME))
                .withInitializer(new ConfigDataApplicationContextInitializer())
                .withConfiguration(AutoConfigurations.of())
                .withUserConfiguration(Properties.class);
    }

    private ApplicationContextRunner runnerFor(String profile) {
        return baseRunner().withPropertyValues("spring.profiles.active=" + profile);
    }

    @Test
    void productionUsesTheInternalOssEndpointAndTheConfiguredDatabase() {
        // The production database address is not in the repo and has no default; it can only come from the deployment environment
        runnerFor("prod").withPropertyValues("ADING_DB_HOST=db.example.test").run(context -> {
            AdingProperties properties = context.getBean(AdingProperties.class);
            assertThat(properties.getSupport().getOssEndpoint())
                    .isEqualTo("https://oss-cn-shanghai-internal.aliyuncs.com");
            assertThat(context.getEnvironment().getProperty("spring.datasource.url"))
                    .contains("db.example.test");
        });
    }

    @Test
    void developmentUsesThePublicOssEndpointAndTheNasDatabase() {
        runnerFor("dev").run(context -> {
            AdingProperties properties = context.getBean(AdingProperties.class);
            assertThat(properties.getSupport().getOssEndpoint())
                    .isEqualTo("https://oss-cn-shanghai.aliyuncs.com");
            assertThat(context.getEnvironment().getProperty("spring.datasource.url"))
                    .contains("localhost:3306")
                    .doesNotContain("rds.aliyuncs.com");
        });
    }

    /** With no profile specified it falls back to dev, so ECS must set prod explicitly. */
    @Test
    void theDefaultProfileIsDevelopment() {
        baseRunner()
                .run(context -> assertThat(context.getBean(AdingProperties.class)
                        .getSupport().getOssEndpoint())
                        .isEqualTo("https://oss-cn-shanghai.aliyuncs.com"));
    }
}
