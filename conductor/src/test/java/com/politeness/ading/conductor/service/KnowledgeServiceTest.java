package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.KnowledgeUrlsRequest;
import com.politeness.ading.conductor.controller.dto.KnowledgeUrlsView;
import com.politeness.ading.conductor.dal.mapper.KnowledgeLockMapper;
import com.politeness.ading.conductor.error.KnowledgeError;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

class KnowledgeServiceTest {

    private final AttachmentStorage storage = mock(AttachmentStorage.class);
    private final KnowledgeLockMapper lockMapper = mock(KnowledgeLockMapper.class);
    private final KnowledgeService service = new KnowledgeService(storage, lockMapper, new AdingProperties());

    @BeforeEach
    void setUp() {
        when(storage.uploadUrl(anyString(), anyString(), any()))
                .thenReturn(new AttachmentStorage.SignedUrl("https://oss/put", Instant.now()));
        when(storage.downloadUrl(anyString(), anyString()))
                .thenReturn(new AttachmentStorage.SignedUrl("https://oss/get", Instant.now()));
        when(storage.deleteUrl(anyString(), any()))
                .thenReturn(new AttachmentStorage.SignedUrl("https://oss/delete", Instant.now()));
        when(lockMapper.holds("u_me", "lock")).thenReturn(true);
    }

    @Test
    void skillListsFilesInDirectory_namesRelativeToUserDirectory() {
        when(storage.list("skill/u_me/")).thenReturn(List.of(
                new AttachmentStorage.StoredObject("skill/u_me/k_1/.ading-meta.json", "E1", 10L),
                new AttachmentStorage.StoredObject("skill/u_me/k_1/scripts/运行.sh", "E2", 10L),
                new AttachmentStorage.StoredObject("skill/u_me/k_1.json", "E3", 10L)));
        var objects = service.list("u_me", "skill");
        assertEquals(List.of("k_1/.ading-meta.json", "k_1/scripts/运行.sh"),
                objects.stream().map(item -> item.name()).toList());
    }

    @Test
    void oneFilePerMemory_unknownObjectsNotReturned() {
        when(storage.list("memory/u_me/")).thenReturn(List.of(
                new AttachmentStorage.StoredObject("memory/u_me/m_1.json", "E1", 10L),
                new AttachmentStorage.StoredObject("memory/u_me/nested/m_2.json", "E2", 10L)));
        var objects = service.list("u_me", "memory");
        assertEquals(1, objects.size());
        assertEquals("m_1.json", objects.get(0).name());
    }

    @Test
    void urlsSignedOnlyUnderOwnDirectory() {
        KnowledgeUrlsView view = service.urls("u_me", "skill",
                new KnowledgeUrlsRequest(List.of("k_1/SKILL.md"), List.of("k_1/scripts/a.sh"), List.of("k_1/old.txt"), "lock"));
        Duration lockTtl = Duration.ofSeconds(300);
        verify(storage).uploadUrl("skill/u_me/k_1/SKILL.md", "text/markdown", lockTtl);
        verify(storage).downloadUrl("skill/u_me/k_1/scripts/a.sh", "a.sh");
        verify(storage).deleteUrl("skill/u_me/k_1/old.txt", lockTtl);
        assertEquals("text/markdown", view.uploads().get("k_1/SKILL.md").contentType());
        assertEquals("https://oss/get", view.downloads().get("k_1/scripts/a.sh"));
        assertEquals("https://oss/delete", view.deletes().get("k_1/old.txt"));
    }

    @Test
    void pathTraversalCannotReachOthersDirectories() {
        for (String name : List.of("../u_other/k_1/SKILL.md", "k_1/../../u_other/x", "k_1//x", "k_1/./x",
                "k_1/a\\b", "k_1/a\nb", "k_1", "k_1/", "/k_1/x", "")) {
            assertThrows(BizException.class, () -> service.urls("u_me", "skill",
                    new KnowledgeUrlsRequest(List.of(name), null, null, "lock")), name);
            assertThrows(BizException.class, () -> service.urls("u_me", "skill",
                    new KnowledgeUrlsRequest(null, null, List.of(name), "lock")), name);
        }
        for (String name : List.of("a/b.json", "m_1.txt", "../m_1.json")) {
            assertThrows(BizException.class, () -> service.urls("u_me", "memory",
                    new KnowledgeUrlsRequest(List.of(name), null, null, "lock")), name);
        }
    }

    @Test
    void uploadAndDeleteRequireLock_downloadDoesNot() {
        for (String token : Arrays.asList(null, "别人的锁")) {
            BizException upload = assertThrows(BizException.class, () -> service.urls("u_me", "skill",
                    new KnowledgeUrlsRequest(List.of("k_1/SKILL.md"), null, null, token)));
            assertEquals(KnowledgeError.LOCK_LOST.code(), upload.getError().code());
            assertThrows(BizException.class, () -> service.urls("u_me", "skill",
                    new KnowledgeUrlsRequest(null, null, List.of("k_1/old.txt"), token)));
        }
        verify(storage, never()).uploadUrl(anyString(), anyString(), any());
        assertEquals("https://oss/get", service.urls("u_me", "skill",
                new KnowledgeUrlsRequest(null, List.of("k_1/SKILL.md"), null, null)).downloads().get("k_1/SKILL.md"));
    }

    @Test
    void acquiringLockClearsExpiredFirst_failureSaysWhenToRetry() {
        when(lockMapper.tryInsert(eq("u_me"), anyString(), eq(300L))).thenReturn(1, 0);
        var first = service.acquireLock("u_me");
        assertTrue(first.granted());
        assertEquals(300L, first.ttlSeconds());
        var second = service.acquireLock("u_me");
        assertFalse(second.granted());
        assertNull(second.token());
        assertEquals(30L, second.retryAfterSeconds());
        verify(lockMapper, times(2)).deleteExpired("u_me");
    }

    @Test
    void unknownKindsAndOversizedRequestsRejected() {
        assertThrows(BizException.class, () -> service.list("u_me", "attachments"));
        assertThrows(BizException.class, () -> service.urls("u_me", "skill",
                new KnowledgeUrlsRequest(Collections.nCopies(101, "k_1/SKILL.md"), null, null, "lock")));
    }
}
