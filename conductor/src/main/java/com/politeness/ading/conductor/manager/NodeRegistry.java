package com.politeness.ading.conductor.manager;

import java.util.Collection;

/**
 * Terminal registry: who is online and how to deliver a frame to a terminal.
 *
 * The only implementation is MQTT's TerminalNodeRegistry. The service layer depends only on this interface and knows nothing about the transport;
 * tests replace it directly.
 */
public interface NodeRegistry {

    /** Whether the agent's computer is currently online; throws PresenceUnknownException when the lookup fails */
    boolean isOnline(String agentUserId);

    /** Whether the terminal is currently connected to MQTT; throws PresenceUnknownException on lookup failure, not treated as offline */
    boolean isTerminalOnline(String terminalId);

    /** Send a frame to the given terminal. Notification only, may be dropped: messages are backfilled via after_seq, state is re-fetched by clients */
    void send(String terminalId, NodeFrame frame);

    /** Send a frame to the terminals of a user (human or agent) */
    void sendToUser(String userId, NodeFrame frame);

    /** Send one frame to each account of a batch of users; each account receives it only once */
    void broadcast(Collection<String> userIds, NodeFrame frame);
}
