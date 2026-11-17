package com.politeness.ading.ops.common;

public class BizException extends RuntimeException {

    private final OpsError error;

    public BizException(OpsError error) {
        super(error.message());
        this.error = error;
    }

    public OpsError error() {
        return error;
    }
}
