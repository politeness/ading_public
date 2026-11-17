package com.politeness.ading.conductor.service;
import com.politeness.ading.conductor.dal.mapper.UserRelMapper;
import com.politeness.ading.conductor.manager.*;
import java.util.LinkedHashSet;
import java.util.Map;
import org.springframework.stereotype.Service;
/** Notify active grantees when the shared Agent's readiness or terminal presence changes. */
@Service
public class AgentShareAudience {
    private final UserRelMapper relations;
    private final org.springframework.beans.factory.ObjectProvider<NodeRegistry> nodes;
    public AgentShareAudience(UserRelMapper relations, org.springframework.beans.factory.ObjectProvider<NodeRegistry> nodes) { this.relations = relations; this.nodes = nodes; }
    public void changed(String owner) {
        var audience = new LinkedHashSet<>(relations.listOwnerShareRecipients(owner)); audience.add(owner);
        nodes.getObject().broadcast(audience, NodeFrame.of(FrameType.AGENTS_CHANGED, Map.of()));
    }
}
