package com.politeness.ading.conductor.common.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;

/**
 * The only scheduled tasks are MQTT connection maintenance and online status refresh; they use a dedicated scheduler pool
 * so that one slow Alibaba Cloud OpenAPI call does not block the other.
 */
@Configuration
@EnableScheduling
public class ThreadPoolConfig {

    @Bean(name = "mqttScheduler")
    public org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler mqttScheduler() {
        var scheduler = new org.springframework.scheduling.concurrent.ThreadPoolTaskScheduler();
        scheduler.setPoolSize(2);
        scheduler.setThreadNamePrefix("mqtt-maintenance-");
        return scheduler;
    }
}
