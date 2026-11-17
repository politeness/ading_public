package com.politeness.ading.conductor.common.config;

import java.util.Arrays;
import java.util.Locale;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * After startup, logs the environment configuration that "Support" actually uses, and checks whether Alibaba Cloud components are mistakenly going over the public network.
 *
 * <p>The environment is determined by profile: prod is the ECS production environment, pre is the pre-release environment on ECS (composed with prod), using the VPC internal network; dev is the NAS development environment,
 * which has no Alibaba Cloud internal network available and uses the public network. The reason there is no "try internal first, fall back to public" runtime probing
 * is that it would make which route is actually used uncertain, and hard to debug when things go wrong.
 *
 * <p>This only warns and does not block: a misconfigured endpoint should not keep the whole service from starting.
 */
@Slf4j
@Component
public class SupportStartupCheck {

    private static final String INTERNAL_MARKER = "-internal.";

    private final AdingProperties properties;
    private final Environment environment;

    public SupportStartupCheck(AdingProperties properties, Environment environment) {
        this.properties = properties;
        this.environment = environment;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void report() {
        AdingProperties.Support support = properties.getSupport();
        String profiles = String.join(",", activeProfiles());
        String endpoint = support.getOssEndpoint() == null ? "" : support.getOssEndpoint().trim();

        if (!support.isEnabled()) {
            log.info("Support service not enabled (profile={}); issue reports and contact-the-developer will both return 503", profiles);
            return;
        }
        log.info("Support service enabled: profile={}, OSS endpoint={}, bucket={}, ops console={}",
                profiles,
                endpoint.isEmpty() ? "(not configured)" : endpoint,
                support.getOssBucket(),
                opsConfigured(support) ? support.getOpsBaseUrl().trim() : "not configured (issue reports and user contacts will both return 503)");

        String warning = endpointWarning(isProduction(), endpoint);
        if (warning != null) log.warn(warning);
    }

    /** Returns a warning when the endpoint does not match the current environment; returns null if it matches. */
    static String endpointWarning(boolean production, String endpoint) {
        String value = endpoint == null ? "" : endpoint.trim();
        if (value.isEmpty()) return null;
        boolean internal = value.contains(INTERNAL_MARKER);
        if (production && !internal) {
            return "The ECS production environment is using a public OSS endpoint (" + value + "). Alibaba Cloud components should talk over the internal network: "
                    + "switch to the -internal domain in the same region, or clear ADING_OSS_ENDPOINT to use the prod default.";
        }
        if (!production && internal) {
            return "The development environment is configured with the internal OSS endpoint (" + value + "), "
                    + "but the NAS is not inside the Alibaba Cloud VPC and cannot resolve that domain.";
        }
        return null;
    }

    private boolean isProduction() {
        return Arrays.stream(activeProfiles())
                .anyMatch(profile -> profile.trim().toLowerCase(Locale.ROOT).equals("prod"));
    }

    private String[] activeProfiles() {
        String[] active = environment.getActiveProfiles();
        return active.length == 0 ? environment.getDefaultProfiles() : active;
    }

    private static boolean opsConfigured(AdingProperties.Support support) {
        return notBlank(support.getOpsBaseUrl()) && notBlank(support.getOpsIngestToken());
    }

    private static boolean notBlank(String value) {
        return value != null && !value.trim().isEmpty();
    }
}
