package com.politeness.ading.ops.service;

import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.model.OSSObject;
import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.config.OpsProperties;
import jakarta.annotation.PreDestroy;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import org.springframework.stereotype.Component;

/**
 * Attachments are relayed through ops instead of giving the browser signed OSS links: the page's content security policy only allows this site's resources,
 * and access always requires an ops session. On ECS it uses the OSS internal endpoint, see application-prod.yml.
 */
@Component
public class OssAttachmentStore implements AttachmentStore {

    private final OpsProperties.Oss config;
    private OSS client;

    public OssAttachmentStore(OpsProperties properties) {
        this.config = properties.getOss();
    }

    @Override
    public void copyTo(String objectKey, OutputStream out) throws IOException {
        try (OSSObject object = client().getObject(config.getBucket(), objectKey);
             InputStream in = object.getObjectContent()) {
            in.transferTo(out);
        }
    }

    private synchronized OSS client() {
        if (client == null) {
            if (isBlank(config.getEndpoint()) || isBlank(config.getBucket())
                    || isBlank(config.getAccessKeyId()) || isBlank(config.getAccessKeySecret())) {
                throw new BizException(OpsError.ATTACHMENT_UNAVAILABLE);
            }
            client = new OSSClientBuilder().build(
                    config.getEndpoint().trim(), config.getAccessKeyId().trim(), config.getAccessKeySecret().trim());
        }
        return client;
    }

    @PreDestroy
    synchronized void close() {
        if (client != null) client.shutdown();
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
