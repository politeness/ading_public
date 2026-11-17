package com.politeness.ading.conductor.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;

import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.mapper.PushDeviceMapper;
import com.politeness.ading.conductor.service.NodeService;
import com.politeness.ading.conductor.service.PushDeviceService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

class PushDeviceApiTest {
    private static final String URL = "/api/v1/terminals/me/push-device";
    private static final String BODY = """
            {"deviceToken":"ABCDEF0123456789ABCDEF0123456789","environment":"production","language":"zh"}""";

    private final PushDeviceMapper devices = mock(PushDeviceMapper.class);
    private final NodeService nodes = mock(NodeService.class);
    private final TerminalEntity terminal = new TerminalEntity();
    private MockMvc mvc;

    @BeforeEach void setUp() {
        terminal.setType("MOBILE");
        when(nodes.requireOwned("t1", "u1")).thenReturn(terminal);
        mvc = MockMvcBuilders.standaloneSetup(new PushDeviceController(new PushDeviceService(devices, nodes)))
                .setControllerAdvice(new GlobalExceptionHandler()).build();
    }

    @AfterEach void clear() {
        AuthContext.clear();
    }

    private void putBody(String body) throws Exception {
        mvc.perform(put(URL).contentType(MediaType.APPLICATION_JSON).content(body));
    }

    @Test void phoneRegistersItsOwnTokenAndTakesItOverFromOtherTerminals() throws Exception {
        AuthContext.set(Principal.ofNode("u1", "t1"));
        putBody(BODY);
        String token = "abcdef0123456789abcdef0123456789";
        verify(devices).deleteOtherHolders(token, "t1");
        ArgumentCaptor<PushDeviceEntity> saved = ArgumentCaptor.forClass(PushDeviceEntity.class);
        verify(devices).upsert(saved.capture());
        assertEquals("t1", saved.getValue().getTerminalId());
        assertEquals("u1", saved.getValue().getOwner());
        assertEquals(token, saved.getValue().getDeviceToken());
    }

    @Test void computersAndUserTokensCannotRegister() throws Exception {
        AuthContext.set(Principal.ofUser("u1"));
        putBody(BODY);
        terminal.setType(TerminalEntity.TYPE_DESKTOP);
        AuthContext.set(Principal.ofNode("u1", "t1"));
        putBody(BODY);
        verify(devices, never()).upsert(any());
    }

    @Test void malformedRequestsAreRejected() throws Exception {
        AuthContext.set(Principal.ofNode("u1", "t1"));
        putBody(BODY.replace("ABCDEF0123456789ABCDEF0123456789", "not-hex"));
        putBody(BODY.replace("production", "staging"));
        putBody(BODY.replace("\"zh\"", "\"fr\""));
        verifyNoInteractions(devices);
    }

    @Test void unregisterDeletesOnlyThisTerminal() throws Exception {
        AuthContext.set(Principal.ofNode("u1", "t1"));
        mvc.perform(delete(URL));
        verify(devices).deleteByTerminal("t1");
        verifyNoMoreInteractions(devices);
    }
}
