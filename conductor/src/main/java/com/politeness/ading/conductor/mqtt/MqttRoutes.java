package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.common.config.AdingProperties;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;
import java.util.Arrays;

/** Environment is selected by trusted server configuration, never a client parameter. */
@Component
public class MqttRoutes {
    private final String environment;
    public MqttRoutes(AdingProperties properties, Environment spring) {
        String configured = properties.getMqtt().getEnvironment();
        var profiles = Arrays.asList(spring.getActiveProfiles());
        environment = configured != null && !configured.isBlank() ? configured
                : profiles.contains("pre") ? "pre" : profiles.contains("prod") ? "prod" : "dev";
        if (!java.util.Set.of("dev", "pre", "prod").contains(environment))
            throw new IllegalArgumentException("Invalid MQTT environment");
    }
    public String environment() { return environment; }
    public String reportRoot() { return environment.equals("prod") ? "report" : "report_" + environment; }
    public String deliverRoot() { return environment.equals("dev") ? "deliver_dev" : "deliver"; }
    public String terminalGroup() { return environment.equals("dev") ? "GID_TERMINAL_DEV" : "GID_TERMINAL"; }
    public String serverGroup() { return environment.equals("dev") ? "GID_SERVER_DEV" : environment.equals("pre") ? "GID_SERVER_PRE" : "GID_SERVER"; }
    public String clientId(String terminalId) { return terminalGroup() + "@@@" + segment(terminalId); }
    public String user(String userId) { return deliverRoot() + "/user/" + segment(userId); }
    public String terminal(String id) { return deliverRoot() + "/terminal/" + segment(id); }
    public String report(String id) { return reportRoot() + "/" + segment(id); }
    public static String segment(String value) {
        if (value == null || !value.matches("[A-Za-z0-9_-]{1,64}")) throw new IllegalArgumentException("Invalid MQTT identifier");
        return value;
    }
}
