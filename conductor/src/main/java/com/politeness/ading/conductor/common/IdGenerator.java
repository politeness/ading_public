package com.politeness.ading.conductor.common;

import java.security.SecureRandom;
import java.util.concurrent.atomic.AtomicLong;
import org.springframework.stereotype.Component;

/**
 * Prefixed ULID generator.
 *
 * Why not UUID v4: the first 48 bits of a ULID are a millisecond timestamp, so it is naturally time-ordered,
 * and as a secondary index in InnoDB's B+ tree it causes far fewer page splits than random UUIDs.
 * The prefix makes logs readable at a glance and makes a wrongly passed argument obvious immediately.
 */
@Component
public class IdGenerator {

    public static final String PREFIX_USER         = "u_";
    public static final String PREFIX_TERMINAL      = "d_";
    public static final String PREFIX_MESSAGE      = "m_";
    /** Conversation ids in old data start with c_; IDs are opaque strings, so both prefixes can coexist */
    public static final String PREFIX_CONVERSATION         = "t_";
    public static final String PREFIX_SESSION      = "s_";
    public static final String PREFIX_TURN         = "r_";
    public static final String PREFIX_WORKSPACE    = "w_";

    /** Crockford Base32, without the easily confused I L O U */
    private static final char[] ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray();

    private final SecureRandom random = new SecureRandom();
    private final AtomicLong lastTimestamp = new AtomicLong(0L);

    public String userId()         { return next(PREFIX_USER); }
    public String terminalId()      { return next(PREFIX_TERMINAL); }
    public String conversationId()         { return next(PREFIX_CONVERSATION); }
    public String messageId()      { return next(PREFIX_MESSAGE); }
    public String sessionId()      { return next(PREFIX_SESSION); }
    public String turnId()         { return next(PREFIX_TURN); }
    public String workspaceId()    { return next(PREFIX_WORKSPACE); }

    public String next(String prefix) {
        return prefix + ulid();
    }

    /** 26 characters: first 10 are the timestamp, last 16 are random */
    public String ulid() {
        long now = System.currentTimeMillis();
        lastTimestamp.accumulateAndGet(now, Math::max);

        char[] out = new char[26];
        long ts = now;
        for (int i = 9; i >= 0; i--) {
            out[i] = ENCODING[(int) (ts & 0x1FL)];
            ts >>>= 5;
        }
        byte[] entropy = new byte[10];
        random.nextBytes(entropy);
        long high = 0L;
        for (int i = 0; i < 5; i++) {
            high = (high << 8) | (entropy[i] & 0xFFL);
        }
        long low = 0L;
        for (int i = 5; i < 10; i++) {
            low = (low << 8) | (entropy[i] & 0xFFL);
        }
        for (int i = 7; i >= 0; i--) {
            out[10 + i] = ENCODING[(int) (high & 0x1FL)];
            high >>>= 5;
        }
        for (int i = 7; i >= 0; i--) {
            out[18 + i] = ENCODING[(int) (low & 0x1FL)];
            low >>>= 5;
        }
        return new String(out);
    }
}
