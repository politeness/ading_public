package com.politeness.ading.conductor.common.auth;

public enum PrincipalType {
    /** Real person, with an access token */
    USER,
    /** Desktop node, with a node token; acts on behalf of the agents it owns */
    NODE
}
