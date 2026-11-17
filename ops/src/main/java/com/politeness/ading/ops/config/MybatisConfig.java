package com.politeness.ading.ops.config;

import com.politeness.ading.ops.dal.mapper.StatisticsExclusions;
import org.mybatis.spring.boot.autoconfigure.ConfigurationCustomizer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class MybatisConfig {
    /** The statistics exclusion list must be ready before the Mappers are parsed. */
    @Bean
    ConfigurationCustomizer statisticsExclusions(@Value("${ading.ops.excluded-users:}") String usernames) {
        return configuration -> StatisticsExclusions.apply(configuration, usernames);
    }
}
