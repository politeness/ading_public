package com.politeness.ading.conductor.mqtt;

import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.mapper.DeviceMapper;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.dal.mapper.TerminalSessionMapper;
import java.time.Duration;
import java.time.LocalDateTime;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

/**
 * Records connection states polled by MqttPresence as sessions so the ops console can compute active duration. All state lives in the database:
 * pre and prod query the same broker and write the same table, so nothing needs restoring on restart; each round reads open sessions once and reconciles them with this round's observations.
 * Serves statistics only; any write failure is just logged and never affects presence notifications; terminals whose lookup failed are left alone this round until the next observation.
 */
@Slf4j
@Component
public class TerminalSessionTracker {

    /** How often to write last_seen_at while connected. Uses the value in the database, so both processes share the same cadence */
    static final Duration TOUCH_INTERVAL = Duration.ofSeconds(30);
    /** If no process has observed for longer than this (all backends were down), we don't know whether it stayed connected: old sessions end at the last observation and the gap is not counted */
    static final Duration OBSERVATION_GAP = Duration.ofMinutes(5);

    private final TerminalSessionMapper sessions;
    private final DeviceMapper devices;
    private final TerminalMapper terminals;

    public TerminalSessionTracker(TerminalSessionMapper sessions, DeviceMapper devices, TerminalMapper terminals) {
        this.sessions = sessions;
        this.devices = devices;
        this.terminals = terminals;
    }

    /** Start of a round: open sessions and the last observation time. Returns null if unreadable, and this round is not recorded */
    public Map<String, LocalDateTime> begin() {
        try {
            Map<String, LocalDateTime> open = new HashMap<>();
            sessions.findOpen().forEach(row -> open.put(row.terminalId(), row.lastSeenAt()));
            return open;
        } catch (RuntimeException error) {
            log.warn("Terminal sessions read failed reason={}", error.getMessage());
            return null;
        }
    }

    public void online(TerminalEntity terminal, Map<String, LocalDateTime> open, LocalDateTime now) {
        if (open == null) return;
        String id = terminal.getTerminalId();
        try {
            LocalDateTime lastSeen = open.get(id);
            if (lastSeen != null && !lastSeen.plus(OBSERVATION_GAP).isAfter(now)) {
                sessions.close(id, null, now);
                lastSeen = null;
            }
            if (lastSeen != null && lastSeen.plus(TOUCH_INTERVAL).isAfter(now)) return;
            if (lastSeen == null) {
                devices.insertIfAbsent(terminal.getFingerprint(), terminal.getType().toLowerCase(Locale.ROOT),
                        terminal.getName(), terminal.getGmtCreated() == null ? now : terminal.getGmtCreated());
            }
            if (lastSeen == null) sessions.open(id, terminal.getFingerprint(), terminal.getOwner(), now);
            else sessions.touch(id, now);
            terminals.touchLastSeen(id, now);
            devices.touchActive(terminal.getFingerprint(), now);
        } catch (RuntimeException error) {
            log.warn("Terminal session write failed terminalId={} reason={}", id, error.getMessage());
        }
    }

    /**
     * @param sawOnline this process still saw it connected last round, so this disconnect was observed directly and the offline time is this observation;
     *                  otherwise it is a leftover session after restart, the real disconnect time is unknown, and last_seen_at is used as the end time
     */
    public void offline(TerminalEntity terminal, boolean sawOnline, Map<String, LocalDateTime> open, LocalDateTime now) {
        if (open == null || !open.containsKey(terminal.getTerminalId())) return;
        close(terminal.getTerminalId(), sawOnline ? now : null, now);
    }

    /** Terminals not queried this round (disabled) won't be observed again, so their open sessions end here. Terminals whose lookup failed count as queried and are not closed here */
    public void finish(Map<String, LocalDateTime> open, Set<String> observed, LocalDateTime now) {
        if (open == null) return;
        open.keySet().stream().filter(id -> !observed.contains(id)).forEach(id -> close(id, null, now));
    }

    private void close(String id, LocalDateTime offlineAt, LocalDateTime now) {
        try {
            sessions.close(id, offlineAt, now);
        } catch (RuntimeException error) {
            log.warn("Terminal session close failed terminalId={} reason={}", id, error.getMessage());
        }
    }
}
