package com.politeness.ading.conductor.mqtt;

import com.aliyuncs.CommonRequest;
import com.aliyuncs.DefaultAcsClient;
import com.aliyuncs.http.MethodType;
import com.aliyuncs.http.ProtocolType;
import com.aliyuncs.profile.DefaultProfile;
import com.politeness.ading.conductor.common.config.AdingProperties;
import jakarta.annotation.PreDestroy;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import java.util.Map;

/** Access key secrets never leave the backend. No credentials are logged. */
@Component
public class MqttCloud {
    private final AdingProperties.Mqtt config;
    private final ObjectMapper json;
    private DefaultAcsClient client;
    public MqttCloud(AdingProperties properties, ObjectMapper json) { this.config = properties.getMqtt(); this.json = json; }
    protected synchronized DefaultAcsClient client() {
        if (client == null) {
            if (config.getRegionId() == null || config.getAccessKeyId() == null || config.getAccessKeySecret() == null)
                throw new IllegalStateException("MQTT OpenAPI credentials are not configured");
            client = new DefaultAcsClient(DefaultProfile.getProfile(config.getRegionId(), config.getAccessKeyId(), config.getAccessKeySecret()));
        }
        return client;
    }
    protected JsonNode call(String action, Map<String, String> values) {
        CommonRequest request = new CommonRequest();
        request.setSysDomain(config.getApiDomain() == null || config.getApiDomain().isBlank()
                ? "onsmqtt." + config.getRegionId() + ".aliyuncs.com" : config.getApiDomain());
        request.setSysVersion("2020-04-20"); request.setSysAction(action);
        request.setSysProtocol(ProtocolType.HTTPS); request.setSysMethod(MethodType.POST);
        request.putQueryParameter("RegionId", config.getRegionId());
        request.putQueryParameter("InstanceId", config.getInstanceId());
        values.forEach(request::putQueryParameter);
        try { return json.readTree(client().getCommonResponse(request).getData()); }
        catch (Exception error) { throw new IllegalStateException("MQTT OpenAPI " + action + " failed", error); }
    }
    public String token(String resources, String actions, long expiresAt) {
        String token = call("ApplyToken", Map.of("Resources", resources, "Actions", actions, "ExpireTime", Long.toString(expiresAt))).path("Token").asText("");
        if (token.isBlank()) throw new IllegalStateException("MQTT returned an empty token");
        return token;
    }
    public boolean online(String clientId) {
        JsonNode result = call("QuerySessionByClientId", Map.of("ClientId", clientId)).path("OnlineStatus");
        if (!result.isBoolean()) throw new IllegalStateException("MQTT returned no connection status");
        return result.asBoolean();
    }
    @PreDestroy public void close() { if (client != null) client.shutdown(); }
}
