package com.politeness.ading.ops.common;

import org.springframework.http.HttpStatus;

/**
 * Ops console error codes. message is a Chinese hint for ops staff and is shown on the page as-is.
 *
 * status is carried separately: not-logged-in must be a real HTTP 401 so the frontend can switch back to the login view;
 * all business failures return 200 with an error code, consistent with conductor's response style.
 */
public enum OpsError {

    NOT_LOGIN        ("OPS_001", "未登录或登录已过期", HttpStatus.UNAUTHORIZED),
    // Not on the ops list, account missing, and wrong password all return this one: separate codes would let someone enumerate ops accounts.
    // OPS_003 (formerly "this account is not an ops account") is therefore retired; the code is not reused so old pages don't misread a new meaning
    BAD_CREDENTIALS  ("OPS_002", "用户名或密码不正确，或该账号没有运维权限", HttpStatus.OK),
    ACCOUNT_DISABLED ("OPS_004", "账号已被禁用", HttpStatus.OK),
    TOO_MANY_TRIES   ("OPS_005", "尝试过于频繁，请稍后再试", HttpStatus.TOO_MANY_REQUESTS),
    BAD_REQUEST      ("OPS_006", "请求参数不合法", HttpStatus.OK),
    INTERNAL         ("OPS_007", "服务端出错，请稍后重试", HttpStatus.INTERNAL_SERVER_ERROR),
    // The concurrent password-verification slots are full (see VerificationGate); does not consume the IP's attempts
    LOGIN_BUSY       ("OPS_008", "登录请求较多，请稍后再试", HttpStatus.SERVICE_UNAVAILABLE),
    ATTACHMENT_UNAVAILABLE("OPS_009", "附件存储未配置", HttpStatus.SERVICE_UNAVAILABLE),
    NOT_FOUND        ("OPS_010", "记录不存在", HttpStatus.NOT_FOUND),
    // Resolved items can't be changed manually any more; items not accepted can't be marked resolved
    STATUS_CONFLICT  ("OPS_011", "当前状态不允许这样修改", HttpStatus.CONFLICT);

    private final String code;
    private final String message;
    private final HttpStatus status;

    OpsError(String code, String message, HttpStatus status) {
        this.code = code;
        this.message = message;
        this.status = status;
    }

    public String code() {
        return code;
    }

    public String message() {
        return message;
    }

    public HttpStatus status() {
        return status;
    }
}
