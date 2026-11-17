package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.controller.dto.SupportReportRequest;
import com.politeness.ading.conductor.controller.dto.SupportReportResponse;
import com.politeness.ading.conductor.dal.entity.MessageEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.FriendError;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;

/**
 * Reporting real people (App Store Review Guideline 1.2 requires a reporting channel).
 *
 * No separate table: build a report and send it through the same channel as issue reports (upload to OSS + email the developer).
 * Evidence is fetched by the server from the database; message content sent by the client is not trusted, since it can be forged.
 */
@Service
public class UserReportService {

    /** Report reasons: the client only sends the code; text is localized on each side */
    public static final Map<String, String> REASONS = Map.of(
            "HARASSMENT", "骚扰或辱骂",
            "SPAM", "垃圾信息或诈骗",
            "INAPPROPRIATE", "色情、暴力等不当内容",
            "OTHER", "其他");

    /** Evidence includes at most this many of the reported user's latest messages in this conversation */
    static final int EVIDENCE_MESSAGES = 20;

    private final UserMapper userMapper;
    private final MessageService messageService;
    private final SupportReportService supportReportService;

    public UserReportService(UserMapper userMapper, MessageService messageService,
                             SupportReportService supportReportService) {
        this.userMapper = userMapper;
        this.messageService = messageService;
        this.supportReportService = supportReportService;
    }

    public SupportReportResponse report(String reporterId, String targetId, String reason, String detail, String conversationId) {
        if (reporterId.equals(targetId)) {
            throw new BizException(FriendError.SELF);
        }
        UserEntity target = userMapper.findByUserId(targetId);
        if (target == null) {
            throw new BizException(FriendError.USER_NOT_FOUND);
        }
        if (Boolean.TRUE.equals(target.getIsAgent())) {
            throw new BizException(FriendError.NOT_A_PERSON);
        }
        String reasonText = reason == null ? null : REASONS.get(reason);
        if (reasonText == null) {
            throw new BizException(FriendError.REPORT_REASON);
        }
        UserEntity reporter = userMapper.findByUserId(reporterId);

        StringBuilder text = new StringBuilder();
        text.append("【举报用户】\n")
            .append("原因：").append(reasonText).append('\n')
            .append("被举报人：").append(describe(target)).append('\n')
            .append("举报人：").append(describe(reporter)).append('\n');
        if (detail != null && !detail.isBlank()) {
            text.append("说明：").append(detail.trim()).append('\n');
        }
        if (conversationId != null && !conversationId.isBlank()) {
            text.append("会话：").append(conversationId).append('\n');
            // The reporter must be a member of this conversation, otherwise fetch rejects it; reporting cannot be used to peek into others' conversations
            List<MessageEntity> evidence = messageService.fetch(conversationId, reporterId, null, null, 200).stream()
                    .filter(message -> targetId.equals(message.getSenderId()))
                    .toList();
            int from = Math.max(0, evidence.size() - EVIDENCE_MESSAGES);
            text.append("被举报人最近的消息（").append(evidence.size() - from).append(" 条）：\n");
            for (MessageEntity message : evidence.subList(from, evidence.size())) {
                text.append("  [").append(message.getGmtCreated()).append("] ")
                    .append(message.getContent().replace('\n', ' ')).append('\n');
            }
        }
        String description = text.length() > SupportReportService.MAX_DESCRIPTION_LENGTH
                ? text.substring(0, SupportReportService.MAX_DESCRIPTION_LENGTH)
                : text.toString();

        // Issue report times are accurate to the second, without milliseconds or nanoseconds
        String now = Instant.now().truncatedTo(ChronoUnit.SECONDS).toString();
        SupportReportRequest request = new SupportReportRequest(
                1, "userreport_" + UUID.randomUUID().toString().replace("-", ""), now, now, description,
                null, List.of(),
                new SupportReportRequest.Context("server", "ios", "-", "user-report", List.of(), null, reporterId, null));
        return supportReportService.uploadAndNotify(request);
    }

    private static String describe(UserEntity user) {
        if (user == null) return "（未知）";
        return user.getDisplayName() + "（用户名 " + user.getUsername() + "，ID " + user.getUserId() + "）";
    }
}
