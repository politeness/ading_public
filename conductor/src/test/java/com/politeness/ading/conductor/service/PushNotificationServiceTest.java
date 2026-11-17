package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

import com.politeness.ading.conductor.common.config.AdingProperties;
import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.PushDeviceMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPairGenerator;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Runs the real ApnsClient against a fake APNs HTTP service: signature verification, sending, removal of invalid tokens, notification content */
class PushNotificationServiceTest {
    private static final String SENDER = "u_sender", PHONE_OWNER = "u_me", AGENT = "u_agent";
    private static final ObjectMapper JSON = new ObjectMapper();

    private record Received(String path, Map<String, String> headers, JsonNode body) {}

    @TempDir Path dir;
    private HttpServer production, sandbox;
    private final List<Received> productionRequests = new ArrayList<>(), sandboxRequests = new ArrayList<>();
    /** token -> {status code, reason} */
    private final Map<String, Object[]> responses = new ConcurrentHashMap<>();
    private ECPublicKey publicKey;
    private final PushDeviceMapper devices = mock(PushDeviceMapper.class);
    private final ConversationUserRelMapper members = mock(ConversationUserRelMapper.class);
    private final ConversationMapper conversations = mock(ConversationMapper.class);
    private final UserMapper users = mock(UserMapper.class);

    @BeforeEach void setUp() throws Exception {
        production = fake(productionRequests);
        sandbox = fake(sandboxRequests);
        when(members.listMemberIds("c1")).thenReturn(List.of(SENDER, PHONE_OWNER, AGENT));
        when(users.findByUserIds(any())).thenReturn(List.of(user(SENDER, "小明", false), user(PHONE_OWNER, "我", false), user(AGENT, "Codex", true)));
        when(members.countUnreadOfUser(PHONE_OWNER)).thenReturn(7);
        ConversationEntity conversation = new ConversationEntity();
        conversation.setType(ConversationEntity.TYPE_DIRECT);
        when(conversations.findByConversationId("c1")).thenReturn(conversation);
    }

    @AfterEach void tearDown() {
        production.stop(0);
        sandbox.stop(0);
    }

    private HttpServer fake(List<Received> sink) throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            Map<String, String> headers = new ConcurrentHashMap<>();
            exchange.getRequestHeaders().forEach((name, values) -> headers.put(name.toLowerCase(), values.getFirst()));
            JsonNode body = JSON.readTree(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            synchronized (sink) { sink.add(new Received(path, headers, body)); }
            Object[] answer = responses.getOrDefault(path.substring(path.lastIndexOf('/') + 1), new Object[]{200, null});
            byte[] reply = answer[1] == null ? new byte[0] : ("{\"reason\":\"" + answer[1] + "\"}").getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders((int) answer[0], reply.length == 0 ? -1 : reply.length);
            if (reply.length > 0) exchange.getResponseBody().write(reply);
            exchange.close();
        });
        server.start();
        return server;
    }

    private PushNotificationService service() throws Exception {
        KeyPairGenerator generator = KeyPairGenerator.getInstance("EC");
        generator.initialize(new ECGenParameterSpec("secp256r1"));
        var pair = generator.generateKeyPair();
        publicKey = (ECPublicKey) pair.getPublic();
        Path p8 = dir.resolve("key.p8");
        Files.writeString(p8, "-----BEGIN PRIVATE KEY-----\n"
                + Base64.getMimeEncoder().encodeToString(pair.getPrivate().getEncoded()) + "\n-----END PRIVATE KEY-----\n");
        return new PushNotificationService(new ApnsClient(properties(p8.toString())), devices, members, conversations, users);
    }

    private AdingProperties properties(String keyPath) {
        AdingProperties properties = new AdingProperties();
        properties.getApns().setKeyId("KEY123");
        properties.getApns().setTeamId("TEAM123");
        properties.getApns().setKeyPath(keyPath);
        properties.getApns().setProductionUrl("http://127.0.0.1:" + production.getAddress().getPort());
        properties.getApns().setSandboxUrl("http://127.0.0.1:" + sandbox.getAddress().getPort());
        return properties;
    }

    private static UserEntity user(String id, String name, boolean agent) {
        UserEntity user = new UserEntity();
        user.setUserId(id);
        user.setDisplayName(name);
        user.setIsAgent(agent);
        return user;
    }

    private static PushDeviceEntity device(String token, String environment) {
        PushDeviceEntity device = new PushDeviceEntity();
        device.setTerminalId("t_" + token);
        device.setOwner(PHONE_OWNER);
        device.setDeviceToken(token);
        device.setEnvironment(environment);
        device.setLanguage("zh");
        return device;
    }

    private static MessageEntity message(String content) {
        MessageEntity message = new MessageEntity();
        message.setMessageId("m1");
        message.setConversationId("c1");
        message.setSenderId(SENDER);
        message.setContent(content);
        return message;
    }

    private void awaitRequests(List<Received> sink, int count) throws Exception {
        long deadline = System.currentTimeMillis() + 5000;
        while (System.currentTimeMillis() < deadline) {
            synchronized (sink) { if (sink.size() >= count) return; }
            Thread.sleep(10);
        }
        fail("expected " + count + " APNs requests, got " + sink.size());
    }

    @Test void sendsSignedRequestToTheDeviceEnvironmentAndOnlyToOtherPeople() throws Exception {
        when(devices.listByOwners(List.of(PHONE_OWNER))).thenReturn(List.of(device("aa01", "production"), device("bb02", "sandbox")));
        service().deliver(message("帮我看下这个 bug"));
        awaitRequests(productionRequests, 1);
        awaitRequests(sandboxRequests, 1);

        verify(devices).listByOwners(List.of(PHONE_OWNER)); // Excludes the sender and Agents
        Received request = productionRequests.getFirst();
        assertEquals("/3/device/aa01", request.path());
        assertEquals("com.politeness.ading", request.headers().get("apns-topic"));
        assertEquals("alert", request.headers().get("apns-push-type"));
        assertEquals("/3/device/bb02", sandboxRequests.getFirst().path());
        JsonNode aps = request.body().get("aps");
        assertEquals("小明", aps.get("alert").get("title").asString());
        assertEquals("帮我看下这个 bug", aps.get("alert").get("body").asString());
        assertFalse(aps.get("alert").has("subtitle")); // Direct chats don't show the conversation name
        assertEquals(7, aps.get("badge").asInt());
        assertEquals("c1", request.body().get("conversationId").asString());

        String[] jwt = request.headers().get("authorization").substring("bearer ".length()).split("\\.");
        JsonNode header = JSON.readTree(Base64.getUrlDecoder().decode(jwt[0]));
        assertEquals("ES256", header.get("alg").asString());
        assertEquals("KEY123", header.get("kid").asString());
        assertEquals("TEAM123", JSON.readTree(Base64.getUrlDecoder().decode(jwt[1])).get("iss").asString());
        Signature verifier = Signature.getInstance("SHA256withECDSAinP1363Format");
        verifier.initVerify(publicKey);
        verifier.update((jwt[0] + "." + jwt[1]).getBytes(StandardCharsets.US_ASCII));
        assertTrue(verifier.verify(Base64.getUrlDecoder().decode(jwt[2])));
    }

    @Test void groupNotificationShowsSenderConversationAndContent() throws Exception {
        when(devices.listByOwners(List.of(PHONE_OWNER))).thenReturn(List.of(device("aa01", "production")));
        ConversationEntity group = new ConversationEntity();
        group.setType("GROUP");
        group.setName("发布群");
        when(conversations.findByConversationId("c1")).thenReturn(group);
        service().deliver(message("今晚发版"));
        awaitRequests(productionRequests, 1);

        JsonNode alert = productionRequests.getFirst().body().get("aps").get("alert");
        assertEquals("小明", alert.get("title").asString());
        assertEquals("发布群", alert.get("subtitle").asString());
        assertEquals("今晚发版", alert.get("body").asString());
    }

    @Test void deadTokensAreDeletedAndOtherFailuresKept() throws Exception {
        responses.put("gone", new Object[]{410, "Unregistered"});
        responses.put("bad", new Object[]{400, "BadDeviceToken"});
        responses.put("busy", new Object[]{503, "ServiceUnavailable"});
        responses.put("topic", new Object[]{400, "TopicDisallowed"});
        when(devices.listByOwners(List.of(PHONE_OWNER))).thenReturn(List.of(device("gone", "production"),
                device("bad", "production"), device("busy", "production"), device("topic", "production")));
        service().deliver(message("hi"));
        awaitRequests(productionRequests, 4);

        verify(devices, timeout(5000)).deleteByToken("gone");
        verify(devices, timeout(5000)).deleteByToken("bad");
        verify(devices, after(300).never()).deleteByToken("busy");
        verify(devices, never()).deleteByToken("topic");
    }

    @Test void expiredProviderTokenIsRenewedAndRetriedOnce() throws Exception {
        responses.put("old", new Object[]{403, "ExpiredProviderToken"});
        when(devices.listByOwners(List.of(PHONE_OWNER))).thenReturn(List.of(device("old", "production")));
        service().deliver(message("hi"));
        awaitRequests(productionRequests, 2);
        Thread.sleep(200);
        assertEquals(2, productionRequests.size());
    }

    @Test void internalMessagesAndUnconfiguredBackendSendNothing() throws Exception {
        MessageEntity internal = message("调度");
        internal.setInternal(true);
        service().messageSaved(internal);
        verifyNoInteractions(members);

        AdingProperties empty = new AdingProperties();
        ApnsClient unconfigured = new ApnsClient(empty);
        assertFalse(unconfigured.configured());
        new PushNotificationService(unconfigured, devices, members, conversations, users).messageSaved(message("hi"));
        verifyNoInteractions(members);

        assertFalse(new ApnsClient(properties(dir.resolve("missing.p8").toString())).configured());
    }

    @Test void savedMessageIsDeliveredInTheBackground() throws Exception {
        when(devices.listByOwners(List.of(PHONE_OWNER))).thenReturn(List.of(device("aa01", "production")));
        service().messageSaved(message("hi"));
        awaitRequests(productionRequests, 1);
    }

    @Test void longContentIsCutWithoutSplittingEmoji() throws Exception {
        PushDeviceEntity device = device("aa01", "production");
        String payload = PushNotificationService.payload(message("😀".repeat(5000)), user(SENDER, "小明", false), null, device, 0);
        String body = JSON.readTree(payload).get("aps").get("alert").get("body").asString();
        assertEquals(181, body.codePointCount(0, body.length()));
        assertTrue(payload.getBytes(StandardCharsets.UTF_8).length < 4096);
        assertEquals("发来一个附件", JSON.readTree(PushNotificationService.payload(message(" "), null, null, device, 0))
                .get("aps").get("alert").get("body").asString());
    }
}
