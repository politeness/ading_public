package com.politeness.ading.ops.controller;

import com.politeness.ading.ops.common.*;
import com.politeness.ading.ops.service.UserTagService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotNull;
import java.util.List;
import org.springframework.web.bind.annotation.*;

/** Cookie ops session + JSON + custom request header; cross-site forms can't send this request, and CORS is not enabled. */
@RestController
@RequestMapping("/api/users")
public class OpsUserTagController {
    private final UserTagService tags;
    public OpsUserTagController(UserTagService tags) { this.tags = tags; }

    public record Change(@NotNull String tag, @NotNull Boolean enabled) {}

    @PostMapping(value = "/{userId}/tags", consumes = "application/json")
    public Result<List<String>> change(@PathVariable String userId, @Valid @RequestBody Change change,
            @RequestHeader(value = "X-Ops-Request", defaultValue = "") String request,
            @RequestAttribute(OpsAuthInterceptor.SESSION_ATTRIBUTE) OpsSession session) {
        if (!"user-tags".equals(request)) throw new BizException(OpsError.BAD_REQUEST);
        return Result.ok(tags.change(userId, change.tag(), change.enabled(), session.username()));
    }
}
