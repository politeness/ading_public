package com.politeness.ading.conductor.common.config;

import lombok.Getter;
import lombok.Setter;
import org.springframework.boot.context.properties.ConfigurationProperties;

@Getter
@Setter
@ConfigurationProperties(prefix = "ading")
public class AdingProperties {

    private Mqtt mqtt = new Mqtt();

    @Getter @Setter
    public static class Mqtt {
        private boolean enabled;
        private String environment;
        private String instanceId;
        private String regionId;
        private String accessKeyId;
        private String accessKeySecret;
        private String apiDomain;
        private String brokerUrl; // Backend TLS endpoint, ssl://host:8883 (currently the public endpoint)
        private String publicBrokerUrl; // Public TLS endpoint, mqtts://host:8883
        private int tokenTtlSeconds = 3600;
        private int keepAliveSeconds = 20;
        private boolean sharedSubscription = true;
        private String reportTransport = "cloud";
        private String cloudDomain;
        private int cloudPort = 5672;
    }

    private Auth auth = new Auth();
    private Support support = new Support();
    private Attachment attachment = new Attachment();
    private Knowledge knowledge = new Knowledge();
    private Apns apns = new Apns();

    /** Mobile push. If any of keyId, teamId, keyPath is empty, nothing is sent and the backend starts normally */
    @Getter
    @Setter
    public static class Apns {
        private String keyId;
        private String teamId;
        /** .p8 file path */
        private String keyPath;
        /** The app's bundle id; the pre-release and production packages use the same one */
        private String topic = "com.politeness.ading";
        private String productionUrl = "https://api.push.apple.com";
        private String sandboxUrl = "https://api.sandbox.push.apple.com";
    }

    @Getter
    @Setter
    public static class Auth {
        private String secret;
        private long accessTokenTtlSeconds  = 7200L;
        private long refreshTokenTtlSeconds = 2592000L;
        private long nodeTokenTtlSeconds    = 31536000L;
    }

    /** Message attachments. The OSS endpoint, bucket, and account are shared with issue reporting (the items under support); only attachment-specific rules go here */
    @Getter
    @Setter
    public static class Attachment {
        private String ossKeyPrefix = "attachments";
        private long maxBytes = 200L * 1024 * 1024;
        private int maxPerMessage = 9;
        /** Validity of the upload URL: a 200 MB video must finish uploading even on a slow network */
        private long uploadTtlMinutes = 60L;
        private long downloadTtlMinutes = 60L;
    }

    /** OSS directories for user skills and memory in the cloud. The OSS endpoint, bucket, and account are shared with issue reporting */
    @Getter
    @Setter
    public static class Knowledge {
        private String skillKeyPrefix = "skill";
        private String memoryKeyPrefix = "memory";
        /** Validity of the sync lock: the holder must renew before expiry; it is released automatically on expiry after a crash or network loss */
        private long lockTtlSeconds = 300L;
        /** Suggested wait before retrying when the lock was not acquired */
        private long lockRetrySeconds = 30L;
    }

    @Getter
    @Setter
    public static class Support {
        private boolean enabled;
        private String ossEndpoint;
        private String ossBucket;
        private String ossAccessKeyId;
        private String ossAccessKeySecret;
        /**
         * Public endpoint used when generating access links. If empty, it is derived from ossEndpoint by removing -internal.
         * Uploads go over the internal network, which is fast and not billed as public traffic, but links are for people to click from outside, so they must use the public domain.
         */
        private String ossPublicEndpoint;
        private String ossPublicBaseUrl;
        private String ossKeyPrefix = "bug_report";
        private long linkTtlHours = 168L;
        /** OSS prefix for user contact attachments */
        private String ossCommunicationKeyPrefix = "communication";
        /** Ops console root URL (including context path); issue reports and user contacts are sent here */
        private String opsBaseUrl;
        /** Shared token for calling the ops console internal API, same as the ops console's ADING_OPS_INGEST_TOKEN */
        private String opsIngestToken;
        /** Backend log file path; if empty, backend logs are not collected */
        private String serverLogPath;
        /** Reports include the last 48 hours of backend logs; beyond this many bytes only the newest part is kept */
        private long serverLogTailBytes = 10L * 1024 * 1024;

        /** Public endpoint for links: if not explicitly configured, -internal is removed from the internal domain. */
        public String resolvedOssPublicEndpoint() {
            if (ossPublicEndpoint != null && !ossPublicEndpoint.isBlank()) return ossPublicEndpoint;
            return ossEndpoint == null ? null : ossEndpoint.replace("-internal.", ".");
        }
    }
}
