package com.politeness.ading.ops.common;

/** Unified response wrapper. On success code is "OK"; on failure code is OpsError.code(). */
public record Result<T>(String code, String message, T data) {

    public static <T> Result<T> ok(T data) {
        return new Result<>("OK", null, data);
    }

    public static Result<Void> ok() {
        return new Result<>("OK", null, null);
    }

    public static <T> Result<T> error(OpsError error) {
        return new Result<>(error.code(), error.message(), null);
    }
}
