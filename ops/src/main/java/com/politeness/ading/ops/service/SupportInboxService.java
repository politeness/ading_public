package com.politeness.ading.ops.service;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.config.OpsProperties;
import com.politeness.ading.ops.controller.dto.PageView;
import com.politeness.ading.ops.controller.dto.SupportDtos.AttachmentIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.AttachmentView;
import com.politeness.ading.ops.controller.dto.SupportDtos.ContactIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.ContactView;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackPage;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackView;
import com.politeness.ading.ops.controller.dto.SupportDtos.IngestResult;
import com.politeness.ading.ops.dal.AttachmentRow;
import com.politeness.ading.ops.dal.ContactRow;
import com.politeness.ading.ops.dal.FeedbackRow;
import com.politeness.ading.ops.dal.mapper.SupportInboxMapper;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Storage, queries and status transitions for issue reports and user contacts.
 *
 * Status: PENDING (default) -> ops manually chooses IGNORED or ACCEPTED -> the processing workflow atomically claims it as IN_PROGRESS, and after fixing and verifying the claimant or ops staff change it to RESOLVED.
 */
@Service
public class SupportInboxService {

    public static final String PENDING = "PENDING";
    public static final String IGNORED = "IGNORED";
    public static final String ACCEPTED = "ACCEPTED";
    public static final String IN_PROGRESS = "IN_PROGRESS";
    public static final String RESOLVED = "RESOLVED";

    static final String OWNER_FEEDBACK = "FEEDBACK";
    static final String OWNER_CONTACT = "CONTACT";

    private static final Set<String> ALL_STATUSES = Set.of(PENDING, IGNORED, ACCEPTED, IN_PROGRESS, RESOLVED);
    private static final Set<String> MANUAL_STATUSES = Set.of(IGNORED, ACCEPTED, RESOLVED);
    private static final int MAX_PAGE_SIZE = 200;

    private final SupportInboxMapper mapper;
    private final OpsProperties properties;

    public SupportInboxService(SupportInboxMapper mapper, OpsProperties properties) {
        this.mapper = mapper;
        this.properties = properties;
    }

    @Transactional
    public IngestResult ingestFeedback(FeedbackIngest request) {
        FeedbackRow row = new FeedbackRow();
        row.setReportId(request.reportId());
        row.setUserId(blankToNull(request.userId()));
        row.setTerminalId(blankToNull(request.terminalId()));
        row.setDescription(request.description());
        row.setOccurredAt(zoned(request.occurredAt()));
        row.setSubmittedAt(zoned(request.createdAt()));
        row.setAppVersion(request.appVersion());
        row.setChannel(channelOf(request.appVersion()));
        row.setPlatform(request.platform());
        row.setArch(request.arch());
        row.setMode(request.mode());
        row.setObjectPrefix(request.objectPrefix());
        if (mapper.insertFeedback(row) == 0) return new IngestResult(request.reportId(), "duplicate");
        saveAttachments(OWNER_FEEDBACK, request.reportId(), request.attachments());
        return new IngestResult(request.reportId(), "created");
    }

    @Transactional
    public IngestResult ingestContact(ContactIngest request) {
        ContactRow row = new ContactRow();
        row.setContactId(request.contactId());
        row.setUserId(blankToNull(request.userId()));
        row.setTerminalId(blankToNull(request.terminalId()));
        row.setSubject(request.subject());
        row.setContent(request.content());
        row.setReplyTo(request.replyTo() == null ? "" : request.replyTo());
        row.setSubmittedAt(zoned(request.createdAt()));
        row.setAppVersion(request.appVersion());
        row.setChannel(channelOf(request.appVersion()));
        row.setPlatform(request.platform());
        row.setArch(request.arch());
        row.setMode(request.mode());
        if (mapper.insertContact(row) == 0) return new IngestResult(request.contactId(), "duplicate");
        saveAttachments(OWNER_CONTACT, request.contactId(), request.attachments());
        return new IngestResult(request.contactId(), "created");
    }

    public FeedbackPage feedback(String status, int page, int size) {
        String filter = status == null || status.isBlank() ? null
                : Set.of("ACTIVE", "COMPLETED").contains(status) ? status : requireStatus(status);
        int current = requirePage(page);
        int limit = requireSize(size);
        List<FeedbackRow> rows = mapper.listFeedback(filter, (current - 1) * limit, limit);
        Map<String, List<AttachmentView>> attachments = attachmentsOf(
                OWNER_FEEDBACK, rows.stream().map(FeedbackRow::getReportId).toList());
        List<FeedbackView> items = rows.stream()
                .map(row -> view(row, attachments.getOrDefault(row.getReportId(), List.of())))
                .toList();
        Map<String, Long> counts = new LinkedHashMap<>();
        List.of(PENDING, ACCEPTED, IN_PROGRESS, IGNORED, RESOLVED).forEach(key -> counts.put(key, 0L));
        mapper.countFeedbackByStatus().forEach(entry -> counts.put(
                String.valueOf(column(entry, "status")), ((Number) column(entry, "total")).longValue()));
        return new FeedbackPage(new PageView<>(current, limit, mapper.countFeedback(filter), items), counts);
    }

    public FeedbackView feedbackDetail(String reportId) {
        FeedbackRow row = mapper.findFeedback(reportId);
        if (row == null) throw new BizException(OpsError.NOT_FOUND);
        return view(row, attachmentsOf(OWNER_FEEDBACK, List.of(reportId)).getOrDefault(reportId, List.of()));
    }

    public FeedbackView changeStatus(String reportId, String status, String operator) {
        if (!MANUAL_STATUSES.contains(status)) throw new BizException(OpsError.BAD_REQUEST);
        int updated = RESOLVED.equals(status)
                ? mapper.confirmResolved(reportId, operator, now())
                : mapper.changeStatus(reportId, status, operator, now());
        if (updated == 0) rejectTransition(reportId);
        return feedbackDetail(reportId);
    }

    public FeedbackView claim(String reportId, String operator) {
        requireOperator(operator);
        if (mapper.claim(reportId, operator, now()) == 0) rejectTransition(reportId);
        return feedbackDetail(reportId);
    }

    public FeedbackView resolve(String reportId, String operator) {
        requireOperator(operator);
        if (mapper.resolve(reportId, operator, now()) == 0) rejectTransition(reportId);
        return feedbackDetail(reportId);
    }

    private static void requireOperator(String operator) {
        if (operator == null || !operator.matches("[a-z0-9][a-z0-9_.:-]{7,63}")) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
    }

    public PageView<ContactView> contacts(int page, int size) {
        int current = requirePage(page);
        int limit = requireSize(size);
        List<ContactRow> rows = mapper.listContacts((current - 1) * limit, limit);
        Map<String, List<AttachmentView>> attachments = attachmentsOf(
                OWNER_CONTACT, rows.stream().map(ContactRow::getContactId).toList());
        return new PageView<>(current, limit, mapper.countContacts(), rows.stream()
                .map(row -> view(row, attachments.getOrDefault(row.getContactId(), List.of())))
                .toList());
    }

    public ContactView contactDetail(String contactId) {
        ContactRow row = mapper.findContact(contactId);
        if (row == null) throw new BizException(OpsError.NOT_FOUND);
        return view(row, attachmentsOf(OWNER_CONTACT, List.of(contactId)).getOrDefault(contactId, List.of()));
    }

    public AttachmentRow attachment(long id) {
        AttachmentRow row = mapper.findAttachment(id);
        if (row == null) throw new BizException(OpsError.NOT_FOUND);
        return row;
    }

    /** Channel is read from the version string suffix: dev build -dev, pre-release -pre, production has no suffix. */
    static String channelOf(String appVersion) {
        String version = appVersion == null ? "" : appVersion.trim().toLowerCase(Locale.ROOT);
        if (version.endsWith("-dev") || version.endsWith("_develop")) return "develop";
        if (version.endsWith("-pre") || version.endsWith("_pre")) return "pre";
        return "release";
    }

    private void saveAttachments(String ownerType, String ownerId, List<AttachmentIngest> attachments) {
        if (attachments == null) return;
        attachments.forEach(item -> {
            AttachmentRow row = new AttachmentRow();
            row.setOwnerType(ownerType);
            row.setOwnerId(ownerId);
            row.setKind(item.kind());
            row.setName(item.name());
            row.setObjectKey(item.objectKey());
            row.setContentType(item.contentType());
            row.setSizeBytes(item.sizeBytes());
            mapper.insertAttachment(row);
        });
    }

    private Map<String, List<AttachmentView>> attachmentsOf(String ownerType, List<String> ownerIds) {
        if (ownerIds.isEmpty()) return Map.of();
        return mapper.findAttachments(ownerType, ownerIds).stream().collect(Collectors.groupingBy(
                AttachmentRow::getOwnerId,
                Collectors.mapping(row -> new AttachmentView(row.getId(), row.getKind(), row.getName(),
                        row.getContentType(), row.getSizeBytes()), Collectors.toList())));
    }

    private static FeedbackView view(FeedbackRow row, List<AttachmentView> attachments) {
        return new FeedbackView(row.getReportId(), row.getUserId(), row.getTerminalId(), row.getStatus(), row.getDescription(), row.getOccurredAt(),
                row.getSubmittedAt(), row.getAppVersion(), row.getChannel(), row.getPlatform(), row.getArch(),
                row.getMode(), row.getObjectPrefix(), row.getHandledBy(), row.getStatusChangedAt(), attachments);
    }

    private static ContactView view(ContactRow row, List<AttachmentView> attachments) {
        return new ContactView(row.getContactId(), row.getUserId(), row.getTerminalId(), row.getSubject(), row.getContent(), row.getReplyTo(),
                row.getSubmittedAt(), row.getAppVersion(), row.getChannel(), row.getPlatform(), row.getArch(),
                row.getMode(), attachments);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private void rejectTransition(String reportId) {
        if (mapper.findFeedback(reportId) == null) throw new BizException(OpsError.NOT_FOUND);
        throw new BizException(OpsError.STATUS_CONFLICT);
    }

    private static String requireStatus(String status) {
        if (!ALL_STATUSES.contains(status)) throw new BizException(OpsError.BAD_REQUEST);
        return status;
    }

    private static int requirePage(int page) {
        if (page < 1) throw new BizException(OpsError.BAD_REQUEST);
        return page;
    }

    private static int requireSize(int size) {
        if (size < 1 || size > MAX_PAGE_SIZE) throw new BizException(OpsError.BAD_REQUEST);
        return size;
    }

    /** Different databases return column names in different cases, so read them case-insensitively. */
    private static Object column(Map<String, Object> row, String name) {
        return row.entrySet().stream().filter(entry -> entry.getKey().equalsIgnoreCase(name))
                .map(Map.Entry::getValue).findFirst().orElse(null);
    }

    /** Client times carry a time zone; they are stored as wall-clock time in the ops console's zone, consistent with other times on the page. */
    private LocalDateTime zoned(String value) {
        try {
            return OffsetDateTime.parse(value).atZoneSameInstant(properties.zoneId()).toLocalDateTime();
        } catch (DateTimeParseException error) {
            throw new BizException(OpsError.BAD_REQUEST);
        }
    }

    private LocalDateTime now() {
        return LocalDateTime.now(properties.zoneId());
    }
}
