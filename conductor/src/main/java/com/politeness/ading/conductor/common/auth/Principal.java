package com.politeness.ading.conductor.common.auth;

/**
 * Identity of the current request.
 * USER: userId is the real person; terminalId is empty.
 * NODE: terminalId is the node, userId is the node's owner.
 */
public record Principal(PrincipalType type, String userId, String terminalId) {

    public static Principal ofUser(String userId) {
        return new Principal(PrincipalType.USER, userId, null);
    }

    public static Principal ofNode(String ownerUserId, String terminalId) {
        return new Principal(PrincipalType.NODE, ownerUserId, terminalId);
    }

    public boolean isNode() {
        return type == PrincipalType.NODE;
    }
}
