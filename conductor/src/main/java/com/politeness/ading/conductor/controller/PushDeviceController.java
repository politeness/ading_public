package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.controller.dto.PushDeviceRequest;
import com.politeness.ading.conductor.error.AuthError;
import com.politeness.ading.conductor.service.PushDeviceService;
import jakarta.validation.Valid;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Mobile registers/unregisters its APNs device token using its own terminal token, so it can still unregister after logout or when the user token is invalid */
@RestController
@RequestMapping("/api/v1/terminals/me/push-device")
public class PushDeviceController {

    private final PushDeviceService service;

    public PushDeviceController(PushDeviceService service) {
        this.service = service;
    }

    @PutMapping
    public Result<Void> register(@Valid @RequestBody PushDeviceRequest request) {
        Principal principal = node();
        service.register(principal.terminalId(), principal.userId(), request);
        return Result.ok(null);
    }

    @DeleteMapping
    public Result<Void> unregister() {
        service.unregister(node().terminalId());
        return Result.ok(null);
    }

    private Principal node() {
        Principal principal = AuthContext.get();
        if (!principal.isNode()) throw new BizException(AuthError.WRONG_TOKEN_TYPE, "This endpoint requires a node token");
        return principal;
    }
}
