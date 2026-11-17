package com.politeness.ading.conductor.controller;

import com.politeness.ading.conductor.common.BizException;
import com.politeness.ading.conductor.common.auth.AuthContext;
import com.politeness.ading.conductor.common.auth.Principal;
import com.politeness.ading.conductor.error.AgentError;
import com.politeness.ading.conductor.service.AgentService;
import org.springframework.stereotype.Component;

/**
 * Whose identity this request acts under: without senderId it is the token owner; with it, it is on behalf of an owned agent, and ownership must be verified.
 * Sending messages, uploading attachments, and marking as read all use it, so there is only one set of rules.
 */
@Component
public class SenderResolver {

    private final AgentService agentService;

    public SenderResolver(AgentService agentService) {
        this.agentService = agentService;
    }

    public String resolve(String senderId) {
        Principal principal = AuthContext.get();
        if (senderId == null || senderId.isBlank() || senderId.equals(principal.userId())) {
            return principal.userId();
        }
        // Acting on behalf of an owned agent: ownership must be verified, otherwise anyone could impersonate any agent
        agentService.requireOwnedAgent(senderId, principal.userId());
        if (principal.isNode()) {
            // A computer token can only represent agents on this computer
            if (principal.terminalId() == null) {
                throw new BizException(AgentError.NOT_ON_THIS_NODE);
            }
            agentService.assertAgentOnNode(principal.terminalId(), senderId);
        }
        return senderId;
    }
}
