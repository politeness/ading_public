package com.politeness.ading.conductor.common;

import com.politeness.ading.conductor.error.BizError;
import lombok.Getter;

@Getter
public class BizException extends RuntimeException {

    private final transient BizError error;

    public BizException(BizError error) {
        super(error.code() + ": " + error.message());
        this.error = error;
    }

    public BizException(BizError error, String detail) {
        super(error.code() + ": " + detail);
        this.error = error;
    }

    public static BizException of(BizError error) {
        return new BizException(error);
    }
}
