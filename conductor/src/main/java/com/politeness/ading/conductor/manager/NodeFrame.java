package com.politeness.ading.conductor.manager;

/**
 * Frame format: { "type": "MESSAGE_NEW", "frameId": 1287, "payload": { ... } }
 *
 * frameId is only for log troubleshooting and progress-frame dedup; it carries no reliability guarantee —
 * reliability comes from three things: message_id idempotency, per-conversation seq, and after_seq backfill after reconnect.
 */
public record NodeFrame(FrameType type, Long frameId, Object payload) {

    public static NodeFrame of(FrameType type, Object payload) {
        return new NodeFrame(type, System.nanoTime(), payload);
    }
}
