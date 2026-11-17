package com.politeness.ading.conductor.common;

import com.politeness.ading.conductor.error.BizError;
import com.politeness.ading.conductor.error.CommonError;

/**
 * Unified response wrapper. On success code is "OK"; on failure code is BizError.code().
 */
public record Result<T>(String code, String message, T data) {

    public static <T> Result<T> ok(T data) {
        return new Result<>(CommonError.OK.code(), null, data);
    }

    public static Result<Void> ok() {
        return new Result<>(CommonError.OK.code(), null, null);
    }

    public static <T> Result<T> error(BizError error) {
        return new Result<>(error.code(), error.message(), null);
    }

    public static <T> Result<T> error(BizError error, String detail) {
        return new Result<>(error.code(), detail == null ? error.message() : detail, null);
    }

    public boolean success() {
        return CommonError.OK.code().equals(code);
    }
}
