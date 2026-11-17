package com.politeness.ading.conductor.manager;

/**
 * Frame types between node and conductor.
 * Sent over MQTT; connection liveness is handled by the broker, so there is no application-level heartbeat frame.
 * TURN_ASSIGN and TURN_RESULT are reserved for TurnService in phase 2.
 */
public enum FrameType {

    // ---- Downstream: conductor → node ----
    MESSAGE_NEW,
    AGENT_UPDATED,
    /** User asked to check one Agent; sent only to that Agent's computer, which runs the real check and re-reports its state. */
    AGENT_VERIFY_REQUEST,
    /**
     * The account's agent list or their online/readiness state changed (a computer went online/offline, or reported a new readiness state).
     * Carries no data; computers that receive it re-fetch /agents. Cross-computer green lights update in real time through this.
     */
    AGENTS_CHANGED,
    CONVERSATION_UPDATED,
    /** Friends or friend requests changed (request received, accepted, or removed). Carries no data; receiving computers re-fetch friends and requests */
    FRIENDS_CHANGED,
    TURN_ASSIGN,

    /** Authenticated task control and execution acknowledgements; never replayed after reconnect. */
    CONVERSATION_CONTROL,
    CONVERSATION_CONTROL_ACCEPTED,
    CONVERSATION_CONTROL_RESULT,

    /** Read/set an Agent's model between computers of the same account: the request goes to the Agent's computer, the reply back to the initiator; not replayed after disconnects. */
    AGENT_MODEL_REQUEST,
    AGENT_MODEL_RESULT,

    // ---- Upstream: node → conductor ----
    TURN_PROGRESS,
    TURN_RESULT
}
