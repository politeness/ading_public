package com.politeness.ading.conductor.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.politeness.ading.conductor.common.config.AdingProperties;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Optional;
import java.util.zip.GZIPInputStream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class ServerLogCollectorTest {

    @TempDir
    Path directory;

    private ServerLogCollector collectorFor(Path logPath, long tailBytes) {
        AdingProperties properties = new AdingProperties();
        properties.getSupport().setServerLogPath(logPath == null ? null : logPath.toString());
        properties.getSupport().setServerLogTailBytes(tailBytes);
        return new ServerLogCollector(properties);
    }

    private static String unzip(byte[] content) throws Exception {
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(content))) {
            return new String(gzip.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    @Test
    void collectsTheWholeFileWhenItFitsInTheTail() throws Exception {
        Path log = directory.resolve("ading.log");
        Files.writeString(log, "第一行\n第二行\n");

        Optional<ServerLogCollector.Snapshot> snapshot = collectorFor(log, 1024).collect();

        assertTrue(snapshot.isPresent());
        assertEquals("服务端日志.log.gz", snapshot.get().name());
        assertEquals("第一行\n第二行\n", unzip(snapshot.get().content()));
    }

    /** The cut point almost always lands mid-line; that partial line must be dropped, or the log starts with a broken fragment. */
    @Test
    void aTruncatedFirstLineIsDropped() throws Exception {
        Path log = directory.resolve("ading.log");
        Files.writeString(log, "很久以前的一整行\n最近的一行\n");
        // Put the cut point right in the middle of the first line: "整行\n最近的一行\n"
        long tail = "整行\n最近的一行\n".getBytes(StandardCharsets.UTF_8).length;

        String collected = unzip(collectorFor(log, tail).collect().orElseThrow().content());

        assertEquals("最近的一行\n", collected);
    }

    @Test
    void compressionActuallyShrinksRepetitiveLogs() throws Exception {
        Path log = directory.resolve("ading.log");
        Files.writeString(log, "INFO c.x.a.conductor 心跳正常\n".repeat(3000));

        ServerLogCollector.Snapshot snapshot = collectorFor(log, 10L * 1024 * 1024).collect().orElseThrow();

        assertTrue(snapshot.content().length * 10 < snapshot.rawBytes(),
                "compressed " + snapshot.content().length + ", raw " + snapshot.rawBytes());
    }

    /** If logs can't be collected, skip them: missing backend logs must never fail the whole issue report. */
    @Test
    void aMissingOrUnsetPathIsNotAnError() {
        assertTrue(collectorFor(null, 1024).collect().isEmpty());
        assertTrue(collectorFor(directory.resolve("不存在.log"), 1024).collect().isEmpty());
    }

    /** Fixed at 2026-09-18 12:00 (+08:00); the window starts at 2026-09-16 12:00. */
    private ServerLogCollector collectorAtNoon(Path logPath, long maxBytes) {
        AdingProperties properties = new AdingProperties();
        properties.getSupport().setServerLogPath(logPath.toString());
        properties.getSupport().setServerLogTailBytes(maxBytes);
        Clock clock = Clock.fixed(Instant.parse("2026-09-18T04:00:00Z"), ZoneId.of("Asia/Shanghai"));
        return new ServerLogCollector(properties, clock);
    }

    /** Reports carry the last 48 hours: rolled files from the previous two days are read in, while older files and lines outside the window are excluded. */
    @Test
    void collectsTheLastFortyEightHoursAcrossRotatedFiles() throws Exception {
        Files.writeString(directory.resolve("ading.2026-09-15.0.log"),
                "2026-09-15T10:00:00.000+08:00  INFO 太早的文件\n");
        Files.writeString(directory.resolve("ading.2026-09-16.0.log"),
                "2026-09-16T11:59:59.000+08:00  INFO 窗口外的一行\n"
                        + "2026-09-16T12:00:01.000+08:00  INFO 窗口内第一行\n");
        Files.writeString(directory.resolve("ading.2026-09-17.1.log"),
                "2026-09-17T20:00:00.000+08:00  INFO 昨天的第二份\n");
        Files.writeString(directory.resolve("ading.2026-09-17.0.log"),
                "2026-09-17T08:00:00.000+08:00  INFO 昨天的第一份\n");
        Path current = directory.resolve("ading.log");
        Files.writeString(current, "2026-09-18T09:00:00.000+08:00  INFO 今天\n");

        String collected = unzip(collectorAtNoon(current, 10L * 1024 * 1024).collect().orElseThrow().content());

        assertEquals("2026-09-16T12:00:01.000+08:00  INFO 窗口内第一行\n"
                + "2026-09-17T08:00:00.000+08:00  INFO 昨天的第一份\n"
                + "2026-09-17T20:00:00.000+08:00  INFO 昨天的第二份\n"
                + "2026-09-18T09:00:00.000+08:00  INFO 今天\n", collected);
    }

    /** Stack-trace continuation lines have no timestamp and are kept or dropped with the line they belong to. */
    @Test
    void stackTraceLinesFollowTheirOwnEntry() throws Exception {
        Path current = directory.resolve("ading.log");
        Files.writeString(current,
                "2026-09-16T08:00:00.000+08:00 ERROR 旧异常\n\tat old.Frame(Old.java:1)\n"
                        + "2026-09-18T08:00:00.000+08:00 ERROR 新异常\n\tat new.Frame(New.java:2)\n");

        String collected = unzip(collectorAtNoon(current, 10L * 1024 * 1024).collect().orElseThrow().content());

        assertFalse(collected.contains("旧异常") || collected.contains("Old.java"), collected);
        assertTrue(collected.contains("新异常") && collected.contains("New.java"), collected);
    }

    /** When the window exceeds the cap, keep only the newest part and drop the partial line at the cut point. */
    @Test
    void theSizeCapKeepsTheNewestLines() throws Exception {
        Path current = directory.resolve("ading.log");
        String older = "2026-09-18T08:00:00.000+08:00  INFO 较早\n";
        String newer = "2026-09-18T09:00:00.000+08:00  INFO 最新\n";
        Files.writeString(current, older + newer);

        String collected = unzip(collectorAtNoon(current, newer.getBytes(StandardCharsets.UTF_8).length + 5)
                .collect().orElseThrow().content());

        assertEquals(newer, collected);
    }

    @Test
    void nothingInTheWindowProducesNothing() throws Exception {
        Path current = directory.resolve("ading.log");
        Files.writeString(current, "2026-09-10T08:00:00.000+08:00  INFO 很久以前\n");
        assertTrue(collectorAtNoon(current, 1024).collect().isEmpty());
    }

    @Test
    void anEmptyLogProducesNothing() throws Exception {
        Path log = directory.resolve("ading.log");
        Files.writeString(log, "");
        assertTrue(collectorFor(log, 1024).collect().isEmpty());
    }
}
