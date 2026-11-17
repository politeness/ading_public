package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.dal.entity.ConversationEntity;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.dal.entity.PushDeviceEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.ConversationMapper;
import com.politeness.ading.conductor.dal.mapper.ConversationUserRelMapper;
import com.politeness.ading.conductor.dal.mapper.PushDeviceMapper;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import jakarta.annotation.PreDestroy;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import tools.jackson.databind.ObjectMapper;

/**
 * After a message is written, send system notifications to the phones of other humans in the conversation. Notifications are just hints; losing one doesn't affect the message, and they must never slow down or fail sending.
 *
 * Whether the user is in the phone's foreground is decided by the phone itself (no banner in the foreground): MQTT presence lags, so skipping based on it during the tens of seconds after backgrounding would miss notifications,
 * and missing one costs more than sending an extra one.
 */
@Slf4j
@Service
public class PushNotificationService {

    /** Enough for lock-screen display and well below the APNs 4 KB limit */
    private static final int MAX_BODY = 180;
    private static final int MAX_TITLE = 60;
    private static final ObjectMapper JSON = new ObjectMapper();

    private final ApnsClient apns;
    private final PushDeviceMapper devices;
    private final ConversationUserRelMapper members;
    private final ConversationMapper conversations;
    private final UserMapper users;
    private final ExecutorService executor = new ThreadPoolExecutor(1, 2, 60, TimeUnit.SECONDS,
            new ArrayBlockingQueue<>(1000), runnable -> {
                Thread thread = new Thread(runnable, "apns-push");
                thread.setDaemon(true);
                return thread;
            });

    public PushNotificationService(ApnsClient apns, PushDeviceMapper devices, ConversationUserRelMapper members,
                                   ConversationMapper conversations, UserMapper users) {
        this.apns = apns;
        this.devices = devices;
        this.members = members;
        this.conversations = conversations;
        this.users = users;
    }

    /** Called after the transaction commits: the message is guaranteed readable when the notification arrives */
    public void messageSaved(MessageEntity message) {
        if (!apns.configured() || Boolean.TRUE.equals(message.getInternal())) return;
        try {
            executor.execute(() -> {
                try {
                    deliver(message);
                } catch (RuntimeException error) {
                    log.warn("APNs push failed messageId={} reason={}", message.getMessageId(), error.toString());
                }
            });
        } catch (RejectedExecutionException full) {
            log.warn("APNs queue full, dropping notification messageId={}", message.getMessageId());
        }
    }

    void deliver(MessageEntity message) {
        List<String> memberIds = members.listMemberIds(message.getConversationId());
        Map<String, UserEntity> byId = new HashMap<>();
        for (UserEntity user : users.findByUserIds(memberIds)) byId.put(user.getUserId(), user);
        List<String> recipients = new ArrayList<>();
        for (String id : memberIds) {
            UserEntity user = byId.get(id);
            if (user != null && !Boolean.TRUE.equals(user.getIsAgent()) && !id.equals(message.getSenderId())) recipients.add(id);
        }
        if (recipients.isEmpty()) return;
        List<PushDeviceEntity> targets = devices.listByOwners(recipients);
        if (targets.isEmpty()) return;

        UserEntity sender = byId.get(message.getSenderId());
        ConversationEntity conversation = conversations.findByConversationId(message.getConversationId());
        Map<String, Integer> badges = new HashMap<>();
        for (PushDeviceEntity device : targets) {
            int badge = badges.computeIfAbsent(device.getOwner(), members::countUnreadOfUser);
            String payload = payload(message, sender, conversation, device, badge);
            apns.send(device, payload, message.getMessageId()).whenComplete((result, error) -> {
                if (error != null) {
                    log.warn("APNs request failed terminalId={} reason={}", device.getTerminalId(), error.toString());
                } else if (result.tokenDead()) {
                    devices.deleteByToken(device.getDeviceToken());
                    log.info("APNs token invalid, deleted terminalId={} status={} reason={}", device.getTerminalId(), result.status(), result.reason());
                } else if (result.status() != 200) {
                    log.warn("APNs rejected terminalId={} status={} reason={}", device.getTerminalId(), result.status(), result.reason());
                }
            });
        }
    }

    /** The notification shows the sender, conversation name (none for direct chats) and body */
    static String payload(MessageEntity message, UserEntity sender, ConversationEntity conversation,
                          PushDeviceEntity device, int badge) {
        boolean zh = "zh".equals(device.getLanguage());
        Map<String, Object> alert = new LinkedHashMap<>();
        String senderName = sender == null ? null : sender.getDisplayName();
        alert.put("title", truncate(senderName == null || senderName.isBlank() ? (zh ? "阿钉" : "ADing") : senderName, MAX_TITLE));
        if (conversation != null && !ConversationEntity.TYPE_DIRECT.equals(conversation.getType()) && conversation.getName() != null) {
            alert.put("subtitle", truncate(conversation.getName(), MAX_TITLE));
        }
        String content = message.getContent() == null ? "" : message.getContent().strip();
        alert.put("body", content.isEmpty() ? (zh ? "发来一个附件" : "Sent an attachment") : truncate(content, MAX_BODY));
        Map<String, Object> aps = new LinkedHashMap<>();
        aps.put("alert", alert);
        aps.put("sound", "default");
        aps.put("badge", badge);
        aps.put("thread-id", message.getConversationId());
        Map<String, Object> root = new LinkedHashMap<>();
        root.put("aps", aps);
        root.put("conversationId", message.getConversationId());
        return JSON.writeValueAsString(root);
    }

    /** Truncate by code point so surrogate pairs like emoji aren't cut in half */
    private static String truncate(String text, int max) {
        if (text.codePointCount(0, text.length()) <= max) return text;
        return text.substring(0, text.offsetByCodePoints(0, max)) + "…";
    }

    @PreDestroy
    void shutdown() {
        executor.shutdown();
    }
}
