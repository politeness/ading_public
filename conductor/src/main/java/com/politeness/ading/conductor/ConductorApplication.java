package com.politeness.ading.conductor;

import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
@MapperScan("com.politeness.ading.conductor.dal.mapper")
public class ConductorApplication {

    public static void main(String[] args) {
        SpringApplication.run(ConductorApplication.class, args);
    }
}
