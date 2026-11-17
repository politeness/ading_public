package com.politeness.ading.conductor.manager;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.error.NodeError;

/**
 * Presence lookup failed: the result is unknown.
 * It is a business exception, so callers get an explicit error code (HTTP 4xx, an error receipt for task control) instead of a 500 or waiting until timeout;
 * places that only display status (contacts, /terminals/me) catch it separately and show "unknown".
 */
public class PresenceUnknownException extends BizException {
    public PresenceUnknownException(Throwable cause) {
        super(NodeError.PRESENCE_UNKNOWN);
        initCause(cause);
    }
}
