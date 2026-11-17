package com.politeness.ading.ops.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.politeness.ading.ops.common.BizException;
import com.politeness.ading.ops.common.OpsError;
import com.politeness.ading.ops.config.OpsProperties;
import com.politeness.ading.ops.controller.dto.SupportDtos.AttachmentIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.ContactIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.ContactView;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackIngest;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackPage;
import com.politeness.ading.ops.controller.dto.SupportDtos.FeedbackView;
import com.politeness.ading.ops.dal.OpsUserRow;
import com.politeness.ading.ops.dal.mapper.OpsUserMapper;
import com.politeness.ading.ops.dal.mapper.SupportInboxMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.Statement;
import java.time.LocalDateTime;
import java.util.List;
import org.apache.ibatis.mapping.Environment;
import org.apache.ibatis.session.Configuration;
import org.apache.ibatis.session.SqlSession;
import org.apache.ibatis.session.SqlSessionFactoryBuilder;
import org.apache.ibatis.transaction.jdbc.JdbcTransactionFactory;
import org.h2.jdbcx.JdbcDataSource;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** Runs the repo's schema script and real SQL (H2) to pin down storage, idempotency and status transitions. */
class SupportInboxServiceTest {

    private Connection keepAlive;
    private SqlSession session;
    private SupportInboxService service;

    @BeforeEach
    void setUp() throws Exception {
        JdbcDataSource dataSource = new JdbcDataSource();
        dataSource.setURL("jdbc:h2:mem:ops_inbox_" + System.nanoTime() + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE");
        keepAlive = dataSource.getConnection();
        try (Statement st = keepAlive.createStatement()) {
            for (String ddl : Files.readString(Path.of("docs/alter-2026-11-02-support-inbox.sql")).split(";")) {
                String sql = ddl.lines().filter(line -> !line.startsWith("--")).reduce("", (a, b) -> a + "\n" + b).trim();
                if (!sql.isEmpty()) st.execute(sql);
            }
            st.execute("""
                    CREATE TABLE users (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(64), username VARCHAR(64),
                      display_name VARCHAR(64), phone VARCHAR(32), email VARCHAR(128), status VARCHAR(16),
                      is_agent TINYINT DEFAULT 0, owner VARCHAR(64), gmt_created DATETIME)""");
            st.execute("CREATE TABLE terminals (owner VARCHAR(64), status VARCHAR(16), last_seen_at DATETIME, terminal_id VARCHAR(64), fingerprint VARCHAR(128), type VARCHAR(32))");
            st.execute("CREATE TABLE devices(device_uuid VARCHAR(128),device_type VARCHAR(16))");
            st.execute("CREATE TABLE terminal_sessions (online_at DATETIME,offline_at DATETIME,open_terminal_id VARCHAR(64), last_seen_at DATETIME, device_uuid VARCHAR(128), user_id VARCHAR(64), terminal_id VARCHAR(64))");
            st.execute("CREATE TABLE device_telemetry_hour (stat_hour DATETIME, device_uuid VARCHAR(128), user_id VARCHAR(64), device_type VARCHAR(16), reported_at DATETIME)");
            st.execute("CREATE TABLE users_rel (user_id VARCHAR(64), friend_id VARCHAR(64), status VARCHAR(16))");
            st.execute("""
                    CREATE TABLE user_tags (id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id VARCHAR(64) NOT NULL,
                      tag VARCHAR(32) NOT NULL, remark VARCHAR(200), UNIQUE (user_id, tag))""");
            st.execute("INSERT INTO users (user_id, username) VALUES ('u_a', 'alice'), ('u_b', 'bob')");
            st.execute("INSERT INTO user_tags (user_id, tag) VALUES ('u_a', 'PRE_GRAY'), ('u_a', 'MAINLAND_ADD_FRIEND')");
        }
        Configuration configuration = new Configuration(new Environment("test", new JdbcTransactionFactory(), dataSource));
        configuration.setMapUnderscoreToCamelCase(true);
        com.politeness.ading.ops.dal.mapper.StatisticsExclusions.apply(configuration, "");
        configuration.addMapper(SupportInboxMapper.class);
        configuration.addMapper(OpsUserMapper.class);
        configuration.addMapper(com.politeness.ading.ops.dal.mapper.UserTagMapper.class);
        session = new SqlSessionFactoryBuilder().build(configuration).openSession(true);
        service = new SupportInboxService(session.getMapper(SupportInboxMapper.class), new OpsProperties());
    }

    @AfterEach
    void tearDown() throws Exception {
        session.close();
        keepAlive.close();
    }

    @Test
    void tagEditsAreIdempotentAndPreserveOtherTags() {
        var tags = new UserTagService(session.getMapper(com.politeness.ading.ops.dal.mapper.UserTagMapper.class));
        assertEquals(List.of("PRE_GRAY", "MAINLAND_ADD_FRIEND"), tags.change("u_a", "PRE_GRAY", true, "ops"));
        assertEquals(List.of("MAINLAND_ADD_FRIEND"), tags.change("u_a", "PRE_GRAY", false, "ops"));
        assertEquals(List.of("MAINLAND_ADD_FRIEND"), tags.change("u_a", "PRE_GRAY", false, "ops"));
        assertEquals(List.of("MAINLAND_ADD_FRIEND", "PRE_GRAY"), tags.change("u_a", "PRE_GRAY", true, "ops"));
        assertEquals(List.of(), tags.change("u_b", "PRE_GRAY", false, "ops"));
        assertEquals(OpsError.BAD_REQUEST, assertThrows(BizException.class,
                () -> tags.change("u_a", "UNKNOWN", true, "ops")).error());
        assertEquals(OpsError.BAD_REQUEST, assertThrows(BizException.class,
                () -> tags.change("u_a", "x' OR 1=1", false, "ops")).error());
        assertEquals(OpsError.NOT_FOUND, assertThrows(BizException.class,
                () -> tags.change("missing", "PRE_GRAY", true, "ops")).error());
    }

    private static FeedbackIngest feedback(String id) {
        return new FeedbackIngest(id, "u_a", "t_a", "2026-11-02T02:00:00Z", "2026-11-02T10:00:05+08:00", "启动白屏",
                "0.10.1-2026.11.2-101010-pre", "darwin", "arm64", "local", "bug_report/u_a/" + id,
                List.of(new AttachmentIngest("screenshot", "截图.png", "bug_report/u_a/" + id + "/images/a.png", "image/png", 12),
                        new AttachmentIngest("log", "last-run.log", "bug_report/u_a/" + id + "/logs/a.log", "application/x-ndjson", 34)));
    }

    @Test
    void feedbackDefaultsToPendingAndStoresContentAndAttachmentKeys() {
        assertEquals("created", service.ingestFeedback(feedback("r1")).status());
        FeedbackView view = service.feedbackDetail("r1");
        assertEquals(SupportInboxService.PENDING, view.status());
        assertEquals("启动白屏", view.description());
        assertEquals("u_a", view.userId());
        assertEquals("pre", view.channel());
        // Zoned times are stored as wall-clock times in the ops console's zone
        assertEquals(LocalDateTime.parse("2026-11-02T10:00:00"), view.occurredAt());
        assertEquals(2, view.attachments().size());
        assertEquals("截图.png", view.attachments().get(0).name());
    }

    @Test
    void retriedReportDoesNotDuplicate() {
        service.ingestFeedback(feedback("r1"));
        assertEquals("duplicate", service.ingestFeedback(feedback("r1")).status());
        FeedbackPage page = service.feedback(null, 1, 20);
        assertEquals(1, page.feedback().total());
        assertEquals(2, page.feedback().items().get(0).attachments().size());
    }

    @Test
    void manualResolutionRequiresInProgressAndResolvedIsFinal() {
        service.ingestFeedback(feedback("r1"));
        assertEquals(OpsError.STATUS_CONFLICT, assertThrows(BizException.class,
                () -> service.changeStatus("r1", "RESOLVED", "opsadmin")).error());
        service.changeStatus("r1", "IGNORED", "opsadmin");
        assertThrows(BizException.class, () -> service.claim("r1", "worker-1"));
        service.changeStatus("r1", "ACCEPTED", "opsadmin");
        assertThrows(BizException.class, () -> service.changeStatus("r1", "RESOLVED", "opsadmin"));
        assertEquals("IN_PROGRESS", service.claim("r1", "worker-1").status());
        assertThrows(BizException.class, () -> service.claim("r1", "worker-2"));
        var resolved = service.changeStatus("r1", "RESOLVED", "opsadmin");
        assertEquals("RESOLVED", resolved.status());
        assertEquals("opsadmin", resolved.handledBy());
        org.junit.jupiter.api.Assertions.assertNotNull(resolved.statusChangedAt());
        assertThrows(BizException.class, () -> service.changeStatus("r1", "IGNORED", "opsadmin"));
        assertThrows(BizException.class, () -> service.changeStatus("r1", "RESOLVED", "opsadmin"));
        assertEquals(resolved.statusChangedAt(), service.feedbackDetail("r1").statusChangedAt());
    }

    @Test
    void agentResolutionRequiresMatchingClaimAndPreservesFinalTime() {
        service.ingestFeedback(feedback("r1"));
        assertThrows(BizException.class, () -> service.resolve("r1", "worker-1"));
        service.changeStatus("r1", "ACCEPTED", "ops");
        assertThrows(BizException.class, () -> service.resolve("r1", "worker-1"));
        service.claim("r1", "worker-1");
        assertThrows(BizException.class, () -> service.resolve("r1", "worker-2"));
        assertThrows(BizException.class, () -> service.resolve("r1", ""));
        assertThrows(BizException.class, () -> service.resolve("missing", "worker-1"));
        var resolved = service.resolve("r1", "worker-1");
        assertEquals("RESOLVED", resolved.status());
        assertEquals("worker-1", resolved.handledBy());
        org.junit.jupiter.api.Assertions.assertNotNull(resolved.statusChangedAt());
        assertThrows(BizException.class, () -> service.resolve("r1", "worker-1"));
        assertEquals(resolved.statusChangedAt(), service.feedbackDetail("r1").statusChangedAt());
    }

    @Test
    void concurrentClaimsHaveExactlyOneWinner() throws Exception {
        service.ingestFeedback(feedback("r1"));
        service.changeStatus("r1", "ACCEPTED", "ops");
        var factory = new SqlSessionFactoryBuilder().build(session.getConfiguration());
        var start = new java.util.concurrent.CountDownLatch(1);
        try (var pool = java.util.concurrent.Executors.newFixedThreadPool(8)) {
            var tasks = new java.util.ArrayList<java.util.concurrent.Future<Integer>>();
            for (int i = 0; i < 8; i++) {
                String worker = "worker-" + i;
                tasks.add(pool.submit(() -> {
                    start.await();
                    try (var own = factory.openSession(true)) {
                        return own.getMapper(SupportInboxMapper.class).claim("r1", worker, LocalDateTime.now());
                    }
                }));
            }
            start.countDown();
            int winners = 0;
            for (var task : tasks) winners += task.get(10, java.util.concurrent.TimeUnit.SECONDS);
            assertEquals(1, winners);
        }
    }

    @Test
    void manualReviewCanReassignOrIgnoreInProgress() {
        service.ingestFeedback(feedback("r1"));
        service.changeStatus("r1", "ACCEPTED", "ops");
        service.claim("r1", "worker-1");
        assertEquals("ACCEPTED", service.changeStatus("r1", "ACCEPTED", "ops").status());
        service.claim("r1", "worker-2");
        assertEquals(1L, service.feedback(null, 1, 20).counts().get("IN_PROGRESS"));
        assertEquals("IGNORED", service.changeStatus("r1", "IGNORED", "ops").status());
        assertThrows(BizException.class, () -> service.changeStatus("r1", "RESOLVED", "ops"));
    }

    @Test
    void claimRequiresAcceptedAndUniqueValidOperator() {
        service.ingestFeedback(feedback("r1"));
        assertEquals(OpsError.STATUS_CONFLICT, assertThrows(BizException.class,
                () -> service.claim("r1", "worker-1")).error());
        assertEquals(OpsError.NOT_FOUND, assertThrows(BizException.class,
                () -> service.claim("missing", "worker-1")).error());
        service.changeStatus("r1", "ACCEPTED", "ops");
        for (String invalid : new String[] {"", "skill", " ", "x".repeat(65), "WORKER-1"}) {
            assertEquals(OpsError.BAD_REQUEST, assertThrows(BizException.class,
                    () -> service.claim("r1", invalid)).error());
        }
    }

    @Test
    void manualChangeCannotSetPendingOrProcessing() {
        service.ingestFeedback(feedback("r1"));
        assertEquals(OpsError.BAD_REQUEST,
                assertThrows(BizException.class, () -> service.changeStatus("r1", "IN_PROGRESS", "x")).error());
        assertEquals(OpsError.NOT_FOUND,
                assertThrows(BizException.class, () -> service.changeStatus("missing", "IGNORED", "x")).error());
    }

    @Test
    void filterAndCountsFollowStatus() {
        service.ingestFeedback(feedback("r1"));
        service.ingestFeedback(feedback("r2"));
        service.changeStatus("r2", "ACCEPTED", "opsadmin");
        FeedbackPage accepted = service.feedback("ACCEPTED", 1, 20);
        assertEquals(1, accepted.feedback().total());
        assertEquals("r2", accepted.feedback().items().get(0).reportId());
        assertEquals(1L, accepted.counts().get("PENDING"));
        assertEquals(0L, accepted.counts().get("RESOLVED"));
        assertThrows(BizException.class, () -> service.feedback("NOPE", 1, 20));
    }

    @Test
    void groupedFiltersIncludeBothStatusesBeforePagination() {
        for (String id : List.of("pending", "accepted", "working", "ignored", "resolved")) {
            service.ingestFeedback(feedback(id));
        }
        service.changeStatus("accepted", "ACCEPTED", "ops");
        service.changeStatus("working", "ACCEPTED", "ops");
        service.claim("working", "worker-1");
        service.changeStatus("ignored", "IGNORED", "ops");
        service.changeStatus("resolved", "ACCEPTED", "ops");
        service.claim("resolved", "worker-1");
        service.resolve("resolved", "worker-1");
        var active = service.feedback("ACTIVE", 1, 1);
        assertEquals(2, active.feedback().total());
        assertEquals(List.of("working"), active.feedback().items().stream().map(FeedbackView::reportId).toList());
        assertEquals("accepted", service.feedback("ACTIVE", 2, 1).feedback().items().get(0).reportId());
        var completed = service.feedback("COMPLETED", 1, 20);
        assertEquals(2, completed.feedback().total());
        assertEquals(List.of("resolved", "ignored"), completed.feedback().items().stream().map(FeedbackView::reportId).toList());
        assertEquals(1, service.feedback("PENDING", 1, 20).feedback().total());
        assertEquals(1L, completed.counts().get("IGNORED"));
        assertEquals(1L, completed.counts().get("RESOLVED"));
        assertThrows(BizException.class, () -> service.changeStatus("pending", "COMPLETED", "ops"));
    }

    @Test
    void contactStoresContentAndAttachments() {
        service.ingestContact(new ContactIngest("c1", null, "t_a", "2026-11-02T02:00:00Z", "合作", "想聊聊", null,
                "0.10.1", "darwin", "arm64", "remote",
                List.of(new AttachmentIngest("file", "方案.pdf", "communication/u_a/c1/1-方案.pdf", "application/pdf", 99))));
        assertEquals("duplicate", service.ingestContact(new ContactIngest("c1", null, "t_a", "2026-11-02T02:00:00Z", "合作", "想聊聊", null,
                "0.10.1", "darwin", "arm64", "remote", List.of())).status());
        ContactView view = service.contacts(1, 20).items().get(0);
        assertEquals("release", view.channel());
        assertEquals("", view.replyTo());
        assertEquals(null, view.userId());
        assertEquals("t_a", view.terminalId());
        assertEquals(1, view.attachments().size());
    }

    @Test
    void channelFollowsVersionSuffix() {
        assertEquals("develop", SupportInboxService.channelOf("0.10.1-2026.11.2-101010-dev"));
        assertEquals("pre", SupportInboxService.channelOf("0.10.1-2026.11.2-101010-pre"));
        assertEquals("release", SupportInboxService.channelOf("0.10.1"));
    }

    @Test
    void usersCarryTheirTags() {
        List<OpsUserRow> rows = session.getMapper(OpsUserMapper.class).searchUsers(null, java.time.LocalDateTime.parse("2026-10-01T00:00:00"), java.time.LocalDateTime.parse("2026-11-03T12:00:00"), 0, 20);
        OpsUserRow alice = rows.stream().filter(row -> "alice".equals(row.getUsername())).findFirst().orElseThrow();
        OpsUserRow bob = rows.stream().filter(row -> "bob".equals(row.getUsername())).findFirst().orElseThrow();
        assertEquals("PRE_GRAY,MAINLAND_ADD_FRIEND", alice.getTags());
        assertEquals(null, bob.getTags());
    }
}
