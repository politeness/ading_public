package com.politeness.ading.conductor.common.auth;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.error.AuthError;

/**
 * Request-scoped identity context. Written by AuthInterceptor and cleared when the request ends.
 */
public final class AuthContext {

    private static final ThreadLocal<Principal> HOLDER = new ThreadLocal<>();

    private AuthContext() {
    }

    public static void set(Principal principal) {
        HOLDER.set(principal);
    }

    public static Principal get() {
        Principal principal = HOLDER.get();
        if (principal == null) {
            throw new BizException(AuthError.TOKEN_MISSING);
        }
        return principal;
    }

    public static Principal peek() {
        return HOLDER.get();
    }

    public static String currentUserId() {
        return get().userId();
    }

    public static void clear() {
        HOLDER.remove();
    }
}
