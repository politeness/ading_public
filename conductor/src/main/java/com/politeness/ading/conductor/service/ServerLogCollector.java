package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.config.AdingProperties;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Optional;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import java.util.zip.GZIPOutputStream;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

/**
 * When an issue is reported, also collect the **backend**'s logs from that time.
 *
 * <p>Desktop logs only explain what happened on the desktop side; reports go through the backend, and OSS upload,
 * mail sending and auth are all in the backend, so without backend logs you only see half the picture.
 *
 * <p>Only the last two days ({@link #WINDOW}) are included, matching the desktop report range. Logs roll daily
 * ({@code ading.<date>.<index>.log}), and today's is {@code ading.log}, so the rolled files from the previous two days are read too,
 * then anything older than 48 hours is cut by the timestamp at the start of each line. Continuation lines without a timestamp, like stack traces, follow the previous line.
 * Logging and retention rules are unaffected.
 *
 * <p>{@code server-log-tail-bytes} is a fallback cap: when a day's log balloons abnormally (once 12 MB in a day), only the newest part is kept.
 *
 * <p>Like desktop, this never throws: if it can't collect, it doesn't, and the report itself must not fail.
 */
@Slf4j
@Component
public class ServerLogCollector {

    public static final String OBJECT_NAME = "服务端日志.log.gz";
    public static final Duration WINDOW = Duration.ofHours(48);

    /** Spring Boot's default log format starts each line with an ISO timestamp with zone, e.g. 2026-09-17T23:18:24.710+08:00 */
    private static final Pattern LINE_TIME = Pattern.compile("^(\\d{4}-\\d{2}-\\d{2}T\\S+)");
    private static final Pattern ROTATED_DATE = Pattern.compile("(\\d{4}-\\d{2}-\\d{2})");

    private final AdingProperties.Support properties;
    private final Clock clock;

    @Autowired
    public ServerLogCollector(AdingProperties adingProperties) {
        this(adingProperties, Clock.systemDefaultZone());
    }

    ServerLogCollector(AdingProperties adingProperties, Clock clock) {
        this.properties = adingProperties.getSupport();
        this.clock = clock;
    }

    public record Snapshot(String name, byte[] content, long rawBytes) {}

    public Optional<Snapshot> collect() {
        String configured = properties.getServerLogPath();
        if (configured == null || configured.isBlank()) return Optional.empty();
        Path current = Path.of(configured.trim());
        try {
            Instant cutoff = clock.instant().minus(WINDOW);
            StringBuilder recent = new StringBuilder();
            for (Path file : filesInWindow(current, cutoff)) {
                recent.append(linesSince(Files.readString(file, StandardCharsets.UTF_8), cutoff));
            }
            byte[] content = limitToNewest(recent.toString().getBytes(StandardCharsets.UTF_8),
                    properties.getServerLogTailBytes());
            if (content.length == 0) return Optional.empty();
            return Optional.of(new Snapshot(OBJECT_NAME, gzip(content), content.length));
        } catch (Exception error) {
            log.warn("Failed to collect backend logs; this report won't include them", error);
            return Optional.empty();
        }
    }

    /** Rolled files within the window, ordered by date and index from old to new, followed by today's file being written. */
    private List<Path> filesInWindow(Path current, Instant cutoff) throws Exception {
        List<Path> files = new ArrayList<>();
        Path directory = current.toAbsolutePath().getParent();
        String fileName = current.getFileName().toString();
        int dot = fileName.lastIndexOf('.');
        String stem = dot > 0 ? fileName.substring(0, dot) : fileName;
        String extension = dot > 0 ? fileName.substring(dot) : "";
        LocalDate firstDay = cutoff.atZone(clock.getZone()).toLocalDate();
        if (directory != null && Files.isDirectory(directory)) {
            try (Stream<Path> listed = Files.list(directory)) {
                listed.filter(path -> {
                            String name = path.getFileName().toString();
                            return !name.equals(fileName) && name.startsWith(stem + ".") && name.endsWith(extension)
                                    && rotatedDate(name).map(day -> !day.isBefore(firstDay)).orElse(false)
                                    && Files.isReadable(path);
                        })
                        .sorted(Comparator.comparing((Path path) -> rotatedDate(path.getFileName().toString()).orElseThrow())
                                .thenComparing(path -> rotatedIndex(path.getFileName().toString(), stem, extension)))
                        .forEach(files::add);
            }
        }
        if (Files.isReadable(current)) files.add(current);
        else log.debug("Backend log unreadable, skipped: {}", current);
        return files;
    }

    private static Optional<LocalDate> rotatedDate(String name) {
        Matcher matcher = ROTATED_DATE.matcher(name);
        if (!matcher.find()) return Optional.empty();
        try {
            return Optional.of(LocalDate.parse(matcher.group(1)));
        } catch (DateTimeParseException error) {
            return Optional.empty();
        }
    }

    /** ading.2026-09-17.3.log → 3; no index counts as 0. */
    private static int rotatedIndex(String name, String stem, String extension) {
        String middle = name.substring(stem.length() + 1, name.length() - extension.length());
        int dot = middle.lastIndexOf('.');
        try {
            return dot >= 0 ? Integer.parseInt(middle.substring(dot + 1)) : 0;
        } catch (NumberFormatException error) {
            return 0;
        }
    }

    /** Keeps only lines timestamped no earlier than cutoff; continuation lines without a timestamp follow the previous line, and those at the start of the file are kept by default. */
    static String linesSince(String content, Instant cutoff) {
        StringBuilder kept = new StringBuilder();
        boolean keep = true;
        for (String line : content.split("\n", -1)) {
            Matcher matcher = LINE_TIME.matcher(line);
            if (matcher.find()) {
                try {
                    keep = !OffsetDateTime.parse(matcher.group(1)).toInstant().isBefore(cutoff);
                } catch (DateTimeParseException error) {
                    // Looks like a timestamp but cannot be parsed; treat it as a continuation line
                }
            }
            if (keep && !line.isEmpty()) kept.append(line).append('\n');
        }
        return kept.toString();
    }

    /** When over the limit, keep only the newest part and drop the partial line at the cut point. */
    static byte[] limitToNewest(byte[] content, long maxBytes) {
        if (maxBytes <= 0 || content.length <= maxBytes) return content;
        int from = (int) (content.length - maxBytes);
        while (from < content.length && content[from - 1] != '\n') from++;
        byte[] trimmed = new byte[content.length - from];
        System.arraycopy(content, from, trimmed, 0, trimmed.length);
        return trimmed;
    }

    private static byte[] gzip(byte[] content) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (GZIPOutputStream gzip = new GZIPOutputStream(out)) {
            gzip.write(content);
        }
        return out.toByteArray();
    }

    /** For the email body description: raw size in bytes and compressed size. */
    public static String describe(Snapshot snapshot) {
        return String.format("%s（最近 %d 小时，原始 %,d 字节，压缩后 %,d 字节）",
                snapshot.name(), WINDOW.toHours(), snapshot.rawBytes(), snapshot.content().length);
    }
}
