package com.politeness.ading.conductor.manager;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Component;

/**
 * What agents on each computer are doing: who is busy and the latest lines of the activity feed. **In memory only, never persisted.**
 *
 * Cross-computer collaboration relies on syncing between clients: a synced message is executed by that computer, and the execution (activity feed, "AI working") must sync back too,
 * otherwise the sending side sees nothing. The feed has several entries per second and is useless once a turn ends, so it stays out of the database:
 *   - the executing side reports an entry over MQTT; it is recorded here and forwarded to the accounts of conversation members;
 *   - phones poll /agents/activity for the current state recorded here, without waiting for the next entry;
 *   - cleared when a turn ends (busy=false) or after 30 seconds without a new report; a service restart loses everything, which is exactly what we want.
 */
@Component
public class TurnActivityBoard {

    /** Each "conversation + agent" keeps only this many recent feed lines, enough for the phone to see how far it has got */
    static final int MAX_LINES = 30;
    /** The receiving side also clears "working" after 30 seconds without progress, so both sides agree */
    static final long EXPIRY_MILLIS = 30_000;

    public static final class Activity {
        public final String ownerId;
        public final String conversationId;
        public final String agentUserId;
        private long expiresAt;
        private final Deque<String> lines = new ArrayDeque<>();

        Activity(String ownerId, String conversationId, String agentUserId) {
            this.ownerId = ownerId;
            this.conversationId = conversationId;
            this.agentUserId = agentUserId;
        }

        public List<String> lines() {
            return List.copyOf(lines);
        }
    }

    private final java.util.function.LongSupplier now;
    public TurnActivityBoard() { this(System::currentTimeMillis); }
    TurnActivityBoard(java.util.function.LongSupplier now) { this.now = now; }

    private final Map<String, Activity> board = new LinkedHashMap<>();

    private static String key(String conversationId, String agentUserId) {
        return conversationId + "\n" + agentUserId;
    }

    /**
     * Record one entry reported by the executing side. busy=false means the turn ended and it is cleared; busy null is just a feed line.
     * While working, the executing side re-reports busy every 10 seconds; with no report for 30 seconds (executor disconnected, end frame lost) it expires.
     */
    public synchronized void record(String ownerId, String conversationId, String agentUserId, Boolean busy, String text) {
        String key = key(conversationId, agentUserId);
        if (Boolean.FALSE.equals(busy)) {
            board.remove(key);
            return;
        }
        Activity activity = board.computeIfAbsent(key, k -> new Activity(ownerId, conversationId, agentUserId));
        activity.expiresAt = now.getAsLong() + EXPIRY_MILLIS;
        if (text != null && !text.isBlank()) {
            activity.lines.addLast(text);
            while (activity.lines.size() > MAX_LINES) activity.lines.removeFirst();
        }
    }

    /** All ongoing activity under an account, for phone polling */
    public synchronized List<Activity> activeFor(String ownerId) {
        board.values().removeIf(activity -> activity.expiresAt <= now.getAsLong());
        List<Activity> result = new ArrayList<>();
        for (Activity activity : board.values()) {
            if (activity.ownerId.equals(ownerId)) result.add(activity);
        }
        return result;
    }

    /** The current feed of one entry. Writes happen under this object's lock, so reads must too, or they race with record on the same queue */
    public synchronized List<String> linesOf(Activity activity) {
        return activity.lines();
    }
}
