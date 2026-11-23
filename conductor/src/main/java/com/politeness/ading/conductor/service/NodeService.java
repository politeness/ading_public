package com.politeness.ading.conductor.service;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.IdGenerator;
import com.politeness.ading.conductor.dal.entity.TerminalEntity;
import com.politeness.ading.conductor.dal.mapper.TerminalMapper;
import com.politeness.ading.conductor.error.CommonError;
import com.politeness.ading.conductor.error.NodeError;
import java.time.LocalDateTime;
import java.util.Set;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Slf4j
@Service
public class NodeService {

    private final TerminalMapper terminalMapper;
    private final IdGenerator idGenerator;

    public NodeService(TerminalMapper terminalMapper, IdGenerator idGenerator) {
        this.terminalMapper = terminalMapper;
        this.idGenerator = idGenerator;
    }

    /**
     * Idempotent by (owner, fingerprint): the same person registering the same machine repeatedly always gets the same terminal_id.
     * desktop calls this on every launch; without idempotency nodes would keep piling up.
     * Phones also register here as MOBILE terminals (to get MQTT credentials for messages), but they are not executors, see {@link #requireExecutionTerminal}.
     * This only handles the account–device association; device parameters like name and version go to devices, see DeviceService. The name column is kept only for old backends.
     */
    @Transactional
    public TerminalEntity register(String ownerUserId, String fingerprint, String name, String type) {
        if (type == null || !Set.of(TerminalEntity.TYPE_DESKTOP, TerminalEntity.TYPE_MOBILE).contains(type)) {
            throw new BizException(CommonError.BAD_REQUEST);
        }
        if (fingerprint == null || fingerprint.isBlank()) {
            throw new BizException(NodeError.FINGERPRINT_BLANK);
        }
        TerminalEntity existing = terminalMapper.findByOwnerAndFingerprint(ownerUserId, fingerprint);
        if (existing != null) {
            if (!type.equals(existing.getType())) throw new BizException(CommonError.BAD_REQUEST);
            if (TerminalEntity.STATUS_DISABLED.equals(existing.getStatus())) {
                throw new BizException(NodeError.NODE_DISABLED);
            }
            return existing;
        }
        TerminalEntity terminal = new TerminalEntity();
        terminal.setTerminalId(idGenerator.terminalId());
        terminal.setType(type);
        terminal.setName(name == null || name.isBlank() ? "我的电脑" : name);
        terminal.setFingerprint(fingerprint);
        terminal.setStatus(TerminalEntity.STATUS_OFFLINE);
        terminal.setOwner(ownerUserId);
        terminalMapper.insert(terminal);
        return terminal;
    }

    /** Login and launch both register, which is evidence of "recently active"; statistics only, a write failure must not block login */
    public void markSeen(String terminalId) {
        try {
            terminalMapper.touchLastSeen(terminalId, LocalDateTime.now());
        } catch (RuntimeException error) {
            log.warn("Failed to record terminal last activity terminalId={} reason={}", terminalId, error.getMessage());
        }
    }

    public TerminalEntity require(String terminalId) {
        TerminalEntity terminal = terminalMapper.findByTerminalId(terminalId);
        if (terminal == null) {
            throw new BizException(NodeError.NODE_NOT_FOUND);
        }
        return terminal;
    }

    public TerminalEntity requireOwned(String terminalId, String ownerUserId) {
        TerminalEntity terminal = require(terminalId);
        if (!terminal.getOwner().equals(ownerUserId)) {
            throw new BizException(NodeError.NOT_NODE_OWNER);
        }
        return terminal;
    }

    /**
     * Shared validation for executor actions (registering Agents, reporting Agent state and progress, replying task-control results, binding workspaces):
     * only computers can run Agents. Phones are auxiliary: they can register terminals, get MQTT credentials, send/receive messages and initiate task control, but cannot be executors.
     */
    public TerminalEntity requireExecutionTerminal(String terminalId, String ownerUserId) {
        TerminalEntity terminal = requireOwned(terminalId, ownerUserId);
        requireExecution(terminal);
        return terminal;
    }

    public static void requireExecution(TerminalEntity terminal) {
        if (!terminal.isExecutionTerminal()) {
            throw new BizException(NodeError.NOT_EXECUTION_TERMINAL);
        }
    }
}
