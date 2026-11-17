package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.KnowledgeLockRenewView;
import com.politeness.ading.conductor.controller.dto.KnowledgeLockView;
import com.politeness.ading.conductor.controller.dto.KnowledgeObjectView;
import com.politeness.ading.conductor.controller.dto.KnowledgeUrlsRequest;
import com.politeness.ading.conductor.controller.dto.KnowledgeUrlsView;
import com.politeness.ading.conductor.dal.mapper.KnowledgeLockMapper;
import com.politeness.ading.conductor.error.KnowledgeError;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.stereotype.Service;

/**
 * Users' skills and memories in the cloud: skill/&lt;userId&gt;/&lt;skillId&gt;/ holds the real directory of the skill package,
 * memory/&lt;userId&gt;/&lt;memoryId&gt;.json holds one object per memory.
 *
 * <p>Files neither pass through the backend nor enter the database: comparing and merging happen on desktop; the backend only enforces "only touch your own directory" and
 * "only one computer per user syncs at a time". The lock lives in the database: pre and prod are two processes sharing one database.
 * Signed write URLs are only valid within the lock's lifetime, so a lost lock holder can't keep writing for long.
 */
@Service
public class KnowledgeService {

    private static final Pattern ITEM_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");
    private static final Pattern MEMORY_NAME = Pattern.compile("[A-Za-z0-9_-]{1,64}\\.json");
    /** OSS object name limit is 1023 bytes; leave room for the prefix */
    private static final int MAX_NAME_BYTES = 900;
    private static final int MAX_URLS = 100;

    private final AttachmentStorage storage;
    private final KnowledgeLockMapper lockMapper;
    private final AdingProperties.Knowledge settings;

    public KnowledgeService(AttachmentStorage storage, KnowledgeLockMapper lockMapper, AdingProperties properties) {
        this.storage = storage;
        this.lockMapper = lockMapper;
        this.settings = properties.getKnowledge();
    }

    public KnowledgeLockView acquireLock(String userId) {
        lockMapper.deleteExpired(userId);
        String token = UUID.randomUUID().toString();
        boolean granted = lockMapper.tryInsert(userId, token, settings.getLockTtlSeconds()) == 1;
        return new KnowledgeLockView(granted, granted ? token : null, settings.getLockTtlSeconds(), settings.getLockRetrySeconds());
    }

    public KnowledgeLockRenewView renewLock(String userId, String token) {
        return new KnowledgeLockRenewView(token != null && lockMapper.renew(userId, token, settings.getLockTtlSeconds()) == 1);
    }

    public void releaseLock(String userId, String token) {
        if (token != null) lockMapper.release(userId, token);
    }

    public List<KnowledgeObjectView> list(String userId, String kind) {
        String prefix = prefix(userId, kind);
        return storage.list(prefix).stream()
                .map(item -> new KnowledgeObjectView(item.key().substring(prefix.length()), item.etag(), item.size()))
                .filter(item -> validName(kind, item.name()))
                .toList();
    }

    public KnowledgeUrlsView urls(String userId, String kind, KnowledgeUrlsRequest request) {
        String prefix = prefix(userId, kind);
        List<String> uploads = request.uploads() == null ? List.of() : request.uploads();
        List<String> downloads = request.downloads() == null ? List.of() : request.downloads();
        List<String> deletes = request.deletes() == null ? List.of() : request.deletes();
        if (uploads.size() + downloads.size() + deletes.size() > MAX_URLS) throw new BizException(KnowledgeError.TOO_MANY);
        if ((!uploads.isEmpty() || !deletes.isEmpty())
                && (request.lockToken() == null || !lockMapper.holds(userId, request.lockToken()))) {
            throw new BizException(KnowledgeError.LOCK_LOST);
        }
        Duration writeTtl = Duration.ofSeconds(settings.getLockTtlSeconds());
        Map<String, KnowledgeUrlsView.Upload> uploadUrls = new LinkedHashMap<>();
        for (String name : uploads) {
            requireName(kind, name);
            String contentType = contentType(name);
            uploadUrls.put(name, new KnowledgeUrlsView.Upload(storage.uploadUrl(prefix + name, contentType, writeTtl).url(), contentType));
        }
        Map<String, String> downloadUrls = new LinkedHashMap<>();
        for (String name : downloads) {
            requireName(kind, name);
            downloadUrls.put(name, storage.downloadUrl(prefix + name, name.substring(name.lastIndexOf('/') + 1)).url());
        }
        Map<String, String> deleteUrls = new LinkedHashMap<>();
        for (String name : deletes) {
            requireName(kind, name);
            deleteUrls.put(name, storage.deleteUrl(prefix + name, writeTtl).url());
        }
        return new KnowledgeUrlsView(uploadUrls, downloadUrls, deleteUrls);
    }

    private String prefix(String userId, String kind) {
        String root = switch (kind) {
            case "skill" -> settings.getSkillKeyPrefix();
            case "memory" -> settings.getMemoryKeyPrefix();
            default -> throw new BizException(KnowledgeError.BAD_KIND);
        };
        return root + "/" + userId + "/";
    }

    private static void requireName(String kind, String name) {
        if (!validName(kind, name)) throw new BizException(KnowledgeError.BAD_NAME);
    }

    private static boolean validName(String kind, String name) {
        if (name == null) return false;
        if ("memory".equals(kind)) return MEMORY_NAME.matcher(name).matches();
        if (name.getBytes(StandardCharsets.UTF_8).length > MAX_NAME_BYTES) return false;
        // skill: <skillId>/<relative path inside the skill package>; file names may contain Chinese but must not escape this directory
        String[] parts = name.split("/", -1);
        if (parts.length < 2 || !ITEM_ID.matcher(parts[0]).matches()) return false;
        for (String part : parts) {
            if (part.isEmpty() || part.equals(".") || part.equals("..") || part.contains("\\")
                    || part.chars().anyMatch(Character::isISOControl)) {
                return false;
            }
        }
        return true;
    }

    /** Text can be previewed directly in the OSS console; everything else is stored as binary, content unaffected */
    private static String contentType(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".md")) return "text/markdown";
        return "application/octet-stream";
    }
}
