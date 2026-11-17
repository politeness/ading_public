package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.controller.dto.AttachmentCreateRequest;
import com.politeness.ading.conductor.controller.dto.AttachmentUploadView;
import com.politeness.ading.conductor.dal.entity.AttachmentEntity;
import com.politeness.ading.conductor.dal.mapper.AttachmentMapper;
import com.politeness.ading.conductor.error.ConversationError;
import java.time.Instant;
import java.util.List;
import java.util.OptionalLong;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

class AttachmentServiceTest {

    private final AttachmentMapper mapper = mock(AttachmentMapper.class);
    private final AttachmentStorage storage = mock(AttachmentStorage.class);
    private final ConversationService conversationService = mock(ConversationService.class);
    private final AttachmentService service = new AttachmentService(
            mapper, storage, conversationService, new AdingProperties(), new ObjectMapper());

    @BeforeEach
    void setUp() {
        when(storage.uploadUrl(anyString(), anyString()))
                .thenReturn(new AttachmentStorage.SignedUrl("https://oss/put", Instant.now()));
        when(storage.downloadUrl(anyString(), anyString()))
                .thenReturn(new AttachmentStorage.SignedUrl("https://oss/get", Instant.now()));
    }

    @Test
    void registeredAttachmentClassifiedByType_objectNameKeepsOnlyExtension() {
        AttachmentUploadView view = service.register("t_1", "u_me",
                new AttachmentCreateRequest("f_1", "截图 2026.PNG", "IMAGE/PNG", 1024L));

        ArgumentCaptor<AttachmentEntity> saved = ArgumentCaptor.forClass(AttachmentEntity.class);
        verify(mapper).insert(saved.capture());
        assertEquals("IMAGE", saved.getValue().getKind());
        assertEquals("image/png", saved.getValue().getMimeType());
        assertEquals("attachments/u_me/image/f_1.png", saved.getValue().getObjectKey());
        assertEquals("截图 2026.PNG", view.attachment().name(), "Display uses the original file name");
        assertEquals("image/png", view.contentType(), "Content-Type on upload must match the signature");
    }

    @Test
    void unknownTypeTreatedAsPlainFile() {
        service.register("t_1", "u_me", new AttachmentCreateRequest("f_2", "report.pdf", "bad type", 10L));
        ArgumentCaptor<AttachmentEntity> saved = ArgumentCaptor.forClass(AttachmentEntity.class);
        verify(mapper).insert(saved.capture());
        assertEquals("application/octet-stream", saved.getValue().getMimeType());
        assertEquals("FILE", saved.getValue().getKind());
    }

    @Test
    void over200MbCannotBeRegistered() {
        BizException error = assertThrows(BizException.class, () -> service.register("t_1", "u_me",
                new AttachmentCreateRequest("f_3", "movie.mov", "video/quicktime", 200L * 1024 * 1024 + 1)));
        assertEquals("FILE_003", error.getError().code());
        verify(mapper, never()).insert(any());
    }

    @Test
    void nonMemberCannotRegisterOrDownload() {
        when(conversationService.requireMember("t_1", "u_stranger")).thenThrow(new BizException(ConversationError.NOT_A_MEMBER));
        assertThrows(BizException.class, () -> service.register("t_1", "u_stranger",
                new AttachmentCreateRequest("f_4", "a.txt", "text/plain", 1L)));
        assertThrows(BizException.class, () -> service.downloadUrl("t_1", "u_stranger", "f_4"));
    }

    @Test
    void reRegisteringSameIdDoesNotCreateNewRecord() {
        when(mapper.findByAttachmentId("f_5")).thenReturn(attachment("f_5", "t_1", "u_me", null));
        service.register("t_1", "u_me", new AttachmentCreateRequest("f_5", "a.txt", "text/plain", 1L));
        verify(mapper, never()).insert(any());
    }

    @Test
    void idRegisteredBySomeoneElseCannotBeReused() {
        when(mapper.findByAttachmentId("f_6")).thenReturn(attachment("f_6", "t_1", "u_other", null));
        BizException error = assertThrows(BizException.class, () -> service.register("t_1", "u_me",
                new AttachmentCreateRequest("f_6", "a.txt", "text/plain", 1L)));
        assertEquals("FILE_001", error.getError().code());
    }

    @Test
    void attachmentFromAnotherConversationGetsNoDownloadUrl() {
        when(mapper.findByAttachmentId("f_7")).thenReturn(attachment("f_7", "t_other", "u_me", null));
        BizException error = assertThrows(BizException.class, () -> service.downloadUrl("t_1", "u_me", "f_7"));
        assertEquals("FILE_005", error.getError().code());
    }

    @Test
    void sendingMessageUsesActualOssSizeAndBuildsAttachmentList() {
        when(mapper.findByAttachmentId("f_8")).thenReturn(attachment("f_8", "t_1", "u_me", null));
        when(storage.size("attachments/t_1/f_8.png")).thenReturn(OptionalLong.of(4096L));

        AttachmentService.Prepared prepared = service.prepare("t_1", "u_me", "m_1", List.of("f_8", "f_8"));

        assertEquals(1, prepared.views().size(), "The same attachment counts only once");
        assertEquals(4096L, prepared.views().get(0).size());
        assertTrue(prepared.json().contains("\"attachmentId\":\"f_8\""));
        service.bind(prepared, "m_1");
        verify(mapper).markSent("f_8", "m_1", 4096L);
    }

    @Test
    void incompleteUploadCannotBeSent() {
        when(mapper.findByAttachmentId("f_9")).thenReturn(attachment("f_9", "t_1", "u_me", null));
        when(storage.size(anyString())).thenReturn(OptionalLong.empty());
        BizException error = assertThrows(BizException.class,
                () -> service.prepare("t_1", "u_me", "m_1", List.of("f_9")));
        assertEquals("FILE_006", error.getError().code());
    }

    @Test
    void attachmentAlreadySentInAnotherMessageCannotBeSentAgain() {
        when(mapper.findByAttachmentId("f_10")).thenReturn(attachment("f_10", "t_1", "u_me", "m_old"));
        BizException error = assertThrows(BizException.class,
                () -> service.prepare("t_1", "u_me", "m_new", List.of("f_10")));
        assertEquals("FILE_007", error.getError().code());
    }

    @Test
    void canOnlySendOwnRegisteredAttachments() {
        when(mapper.findByAttachmentId("f_11")).thenReturn(attachment("f_11", "t_1", "u_other", null));
        assertThrows(BizException.class, () -> service.prepare("t_1", "u_me", "m_1", List.of("f_11")));
    }

    @Test
    void atMostNineAttachmentsPerMessage() {
        List<String> ids = List.of("a", "b", "c", "d", "e", "f", "g", "h", "i", "j");
        BizException error = assertThrows(BizException.class, () -> service.prepare("t_1", "u_me", "m_1", ids));
        assertEquals("FILE_004", error.getError().code());
    }

    @Test
    void attachmentColumnNotWrittenWithoutAttachments() {
        AttachmentService.Prepared prepared = service.prepare("t_1", "u_me", "m_1", null);
        assertTrue(prepared.isEmpty());
        assertNull(prepared.json());
        verify(storage, never()).size(anyString());
        verify(mapper, never()).markSent(anyString(), eq("m_1"), any(Long.class));
    }

    private static AttachmentEntity attachment(String id, String conversationId, String uploader, String messageId) {
        AttachmentEntity attachment = new AttachmentEntity();
        attachment.setAttachmentId(id);
        attachment.setConversationId(conversationId);
        attachment.setUploaderId(uploader);
        attachment.setMessageId(messageId);
        attachment.setName("a.png");
        attachment.setMimeType("image/png");
        attachment.setSizeBytes(1L);
        attachment.setKind("IMAGE");
        attachment.setObjectKey("attachments/" + conversationId + "/" + id + ".png");
        attachment.setStatus("PENDING");
        return attachment;
    }
}
