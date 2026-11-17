package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.error.AuthError;
import com.politeness.ading.conductor.error.NodeError;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.mqtt.MqttCredentialsService;
import com.politeness.ading.conductor.service.NodeService;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v1/mqtt")
public class MqttController {
    private final NodeService nodes;
    private final MqttCredentialsService credentials;
    public MqttController(NodeService nodes, MqttCredentialsService credentials) { this.nodes = nodes; this.credentials = credentials; }
    @PostMapping("/credentials")
    public Result<MqttCredentialsService.Credentials> credentials() {
        var principal = AuthContext.get();
        if (!principal.isNode()) throw new BizException(AuthError.WRONG_TOKEN_TYPE);
        var terminal = nodes.requireOwned(principal.terminalId(), principal.userId());
        if (TerminalEntity.STATUS_DISABLED.equals(terminal.getStatus())) throw new BizException(NodeError.NODE_DISABLED);
        return Result.ok(credentials.issue(terminal));
    }
}
