package com.politeness.ading.conductor.service;

import com.aliyun.oss.ClientException;
import com.aliyun.oss.HttpMethod;
import com.aliyun.oss.OSS;
import com.aliyun.oss.OSSClientBuilder;
import com.aliyun.oss.OSSException;
import com.aliyun.oss.model.GeneratePresignedUrlRequest;
import com.aliyun.oss.model.ListObjectsRequest;
import com.aliyun.oss.model.OSSObjectSummary;
import com.aliyun.oss.model.ObjectListing;
import com.aliyun.oss.model.ResponseHeaderOverrides;
import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.error.AttachmentError;
import jakarta.annotation.PreDestroy;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.OptionalLong;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * Attachments live in another directory of the same OSS bucket as issue reports, sharing the account too.
 *
 * <p>Signed URLs are used by phones and computers over the public internet, so signing uses the public endpoint;
 * checking whether a file is fully uploaded uses the configured endpoint (internal on ECS, no public traffic).
 * Generating a signature itself makes no network request.
 */
@Slf4j
@Component
public class OssAttachmentStorage implements AttachmentStorage {

    private final AdingProperties.Support oss;
    private final AdingProperties.Attachment settings;
    private volatile OSS client;
    private volatile OSS signer;

    public OssAttachmentStorage(AdingProperties properties) {
        this.oss = properties.getSupport();
        this.settings = properties.getAttachment();
    }

    @Override
    public SignedUrl uploadUrl(String objectKey, String mimeType) {
        return uploadUrl(objectKey, mimeType, Duration.ofMinutes(settings.getUploadTtlMinutes()));
    }

    @Override
    public SignedUrl uploadUrl(String objectKey, String mimeType, Duration ttl) {
        Instant expiresAt = Instant.now().plus(ttl);
        GeneratePresignedUrlRequest request = new GeneratePresignedUrlRequest(oss.getOssBucket(), objectKey, HttpMethod.PUT);
        request.setExpiration(Date.from(expiresAt));
        request.setContentType(mimeType);
        return new SignedUrl(signer().generatePresignedUrl(request).toString(), expiresAt);
    }

    @Override
    public SignedUrl downloadUrl(String objectKey, String filename) {
        Instant expiresAt = Instant.now().plus(Duration.ofMinutes(settings.getDownloadTtlMinutes()));
        GeneratePresignedUrlRequest request = new GeneratePresignedUrlRequest(oss.getOssBucket(), objectKey, HttpMethod.GET);
        request.setExpiration(Date.from(expiresAt));
        ResponseHeaderOverrides headers = new ResponseHeaderOverrides();
        // Encode Chinese file names per RFC 5987, otherwise downloads come out garbled
        headers.setContentDisposition("inline; filename*=UTF-8''"
                + URLEncoder.encode(filename, StandardCharsets.UTF_8).replace("+", "%20"));
        request.setResponseHeaders(headers);
        return new SignedUrl(signer().generatePresignedUrl(request).toString(), expiresAt);
    }

    @Override
    public SignedUrl deleteUrl(String objectKey, Duration ttl) {
        Instant expiresAt = Instant.now().plus(ttl);
        GeneratePresignedUrlRequest request = new GeneratePresignedUrlRequest(oss.getOssBucket(), objectKey, HttpMethod.DELETE);
        request.setExpiration(Date.from(expiresAt));
        return new SignedUrl(signer().generatePresignedUrl(request).toString(), expiresAt);
    }

    @Override
    public OptionalLong size(String objectKey) {
        try {
            return OptionalLong.of(client().getObjectMetadata(oss.getOssBucket(), objectKey).getContentLength());
        } catch (OSSException error) {
            if ("NoSuchKey".equals(error.getErrorCode())) return OptionalLong.empty();
            log.warn("Failed to query attachment key={}", objectKey, error);
            throw new BizException(AttachmentError.UNAVAILABLE);
        }
    }

    @Override
    public List<StoredObject> list(String prefix) {
        List<StoredObject> objects = new ArrayList<>();
        try {
            String marker = null;
            do {
                ObjectListing listing = client().listObjects(new ListObjectsRequest(oss.getOssBucket())
                        .withPrefix(prefix).withMarker(marker).withMaxKeys(1000));
                for (OSSObjectSummary item : listing.getObjectSummaries()) {
                    objects.add(new StoredObject(item.getKey(), item.getETag(), item.getSize()));
                }
                marker = listing.isTruncated() ? listing.getNextMarker() : null;
            } while (marker != null);
        } catch (OSSException | ClientException error) {
            log.warn("Failed to list OSS objects prefix={}", prefix, error);
            throw new BizException(AttachmentError.UNAVAILABLE);
        }
        return objects;
    }

    private OSS client() {
        if (client == null) {
            synchronized (this) {
                if (client == null) client = build(oss.getOssEndpoint());
            }
        }
        return client;
    }

    private OSS signer() {
        if (signer == null) {
            synchronized (this) {
                if (signer == null) signer = build(oss.resolvedOssPublicEndpoint());
            }
        }
        return signer;
    }

    private OSS build(String endpoint) {
        if (isBlank(endpoint) || isBlank(oss.getOssBucket())
                || isBlank(oss.getOssAccessKeyId()) || isBlank(oss.getOssAccessKeySecret())) {
            throw new BizException(AttachmentError.UNAVAILABLE);
        }
        return new OSSClientBuilder().build(endpoint, oss.getOssAccessKeyId(), oss.getOssAccessKeySecret());
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    @PreDestroy
    void shutdown() {
        if (client != null) client.shutdown();
        if (signer != null) signer.shutdown();
    }
}
