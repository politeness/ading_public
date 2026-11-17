package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.Result;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.common.auth.TokenService;
import com.politeness.ading.conductor.controller.dto.AgentStateReport;
import com.politeness.ading.conductor.controller.dto.NodeMeResponse;
import com.politeness.ading.conductor.controller.dto.NodeRegisterRequest;
import com.politeness.ading.conductor.controller.dto.NodeRegisterResponse;
import com.politeness.ading.conductor.controller.dto.UserView;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.entity.UserEntity;
import com.politeness.ading.conductor.dal.mapper.UserMapper;
import com.politeness.ading.conductor.error.AuthError;
import com.politeness.ading.conductor.manager.NodeRegistry;
import com.politeness.ading.conductor.manager.PresenceUnknownException;
import com.politeness.ading.conductor.service.AgentStateService;
import com.politeness.ading.conductor.service.DeviceService;
import com.politeness.ading.conductor.service.NodeService;
import jakarta.validation.Valid;
import jakarta.servlet.http.HttpServletRequest;
import com.politeness.ading.conductor.common.ClientIp;
import java.util.ArrayList;
import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/terminals")
public class NodeController {

    private final NodeRegistry registry;
    private final NodeService nodeService;
    private final TokenService tokenService;
    private final UserMapper userMapper;
    private final AgentStateService agentStateService;
    private final DeviceService deviceService;

    public NodeController(NodeService nodeService, TokenService tokenService,
                          UserMapper userMapper,
                          AgentStateService agentStateService, NodeRegistry registry,
                          DeviceService deviceService) {
        this.deviceService = deviceService;
        this.nodeService = nodeService;
        this.registry = registry;
        this.tokenService = tokenService;
        this.userMapper = userMapper;
        this.agentStateService = agentStateService;
    }

    /**
     * This computer publishes the state of its own agents (computer token). Same idea as message sync:
     * this computer is the authority; the server stores it and notifies other computers on the same account, which set traffic lights from it.
     */
    @PutMapping("/me/agent-states")
    public Result<Integer> publishAgentStates(@Valid @RequestBody AgentStateReport report) {
        Principal principal = AuthContext.get();
        if (!principal.isNode()) {
            throw new BizException(AuthError.WRONG_TOKEN_TYPE, "This endpoint requires a node token");
        }
        // Only computers have Agents; mobile terminal tokens get NODE_007
        nodeService.requireExecutionTerminal(principal.terminalId(), principal.userId());
        return Result.ok(agentStateService.publish(principal.terminalId(), principal.userId(), report.agents()));
    }

    /**
     * Register a terminal (computer DESKTOP or mobile MOBILE) with a user token, getting a node token in return.
     * Phase one has no pairing code: log in with account and password directly on the desktop and register with the user token.
     * A mobile node token is only used to exchange MQTT credentials; executor endpoints reject it via NodeService.requireExecutionTerminal.
     */
    @PostMapping("/register")
    public Result<NodeRegisterResponse> register(@Valid @RequestBody NodeRegisterRequest request, HttpServletRequest http) {
        Principal principal = AuthContext.get();
        if (principal.isNode()) {
            throw new BizException(AuthError.WRONG_TOKEN_TYPE, "Registering a node requires a user token");
        }
        TerminalEntity terminal = nodeService.register(
                principal.userId(), request.fingerprint(), request.name(), request.type());
        nodeService.markSeen(terminal.getTerminalId());
        deviceService.registered(request.fingerprint(), terminal.getType(), request.name(),
                request.appVersion(), request.osVersion(), ClientIp.of(http));
        Integer epoch = userMapper.findTokenEpoch(terminal.getOwner());
        String nodeToken = tokenService.issueNodeToken(
                terminal.getOwner(), terminal.getTerminalId(), epoch == null ? 0 : epoch);
        return Result.ok(new NodeRegisterResponse(terminal.getTerminalId(), deviceService.nameOf(terminal), nodeToken));
    }

    @GetMapping("/me")
    public Result<NodeMeResponse> me() {
        Principal principal = AuthContext.get();
        if (!principal.isNode()) {
            throw new BizException(AuthError.WRONG_TOKEN_TYPE, "This endpoint requires a node token");
        }
        TerminalEntity terminal = nodeService.requireOwned(principal.terminalId(), principal.userId());

        List<UserView> agents = new ArrayList<>();
        for (UserEntity agent : userMapper.findAgentsByTerminal(terminal.getTerminalId())) {
            agents.add(UserView.from(agent));
        }
        String status = terminal.getStatus();
        if (!TerminalEntity.STATUS_DISABLED.equals(status)) {
            try { status = registry.isTerminalOnline(terminal.getTerminalId()) ? TerminalEntity.STATUS_ONLINE : TerminalEntity.STATUS_OFFLINE; }
            catch (PresenceUnknownException unknown) { status = null; }
        }
        return Result.ok(new NodeMeResponse(terminal.getTerminalId(), deviceService.nameOf(terminal), status, terminal.getOwner(), agents));
    }
}
