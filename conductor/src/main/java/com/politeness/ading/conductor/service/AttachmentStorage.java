package com.politeness.ading.conductor.service;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.OptionalLong;

/**
 * Where attachment files are stored. OSS is the only implementation; the interface exists so unit tests don't hit real OSS.
 */
public interface AttachmentStorage {

    /** Time-limited upload URL: the client PUTs directly, and Content-Type must match the one used for signing */
    SignedUrl uploadUrl(String objectKey, String mimeType);

    /** Time-limited download URL; filename makes browsers and the OS use the original file name when downloading */
    SignedUrl downloadUrl(String objectKey, String filename);

    /** Upload URL with a given validity period */
    SignedUrl uploadUrl(String objectKey, String mimeType, Duration ttl);

    /** Time-limited delete URL */
    SignedUrl deleteUrl(String objectKey, Duration ttl);

    /** Returns the actual size if the file has been uploaded, empty otherwise */
    OptionalLong size(String objectKey);

    /** List all objects under the prefix */
    List<StoredObject> list(String prefix);

    record StoredObject(String key, String etag, long size) {
    }

    record SignedUrl(String url, Instant expiresAt) {
    }
}
