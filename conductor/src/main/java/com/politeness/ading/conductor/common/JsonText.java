package com.politeness.ading.conductor.common;

import tools.jackson.databind.JsonNode;

/**
 * The extra in a request is the desktop scheduler's runtime state; the backend only stores and returns it without parsing:
 * whatever JSON comes in is stored as text as is, and emitted as is with @JsonRawValue on the way out.
 */
public final class JsonText {

    private JsonText() {
    }

    /** Both null and JSON null mean "no change this time" */
    public static String of(JsonNode node) {
        return node == null || node.isNull() ? null : node.toString();
    }
}
