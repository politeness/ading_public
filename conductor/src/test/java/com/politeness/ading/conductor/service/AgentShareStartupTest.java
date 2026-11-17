package com.politeness.ading.conductor.service;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.politeness.ading.conductor.dal.mapper.UserRelMapper;
import com.politeness.ading.conductor.manager.NodeRegistry;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.*;
import org.springframework.beans.factory.ObjectProvider;
class AgentShareStartupTest {
    @Configuration static class Wiring {
        @Bean UserRelMapper relations() { return mock(UserRelMapper.class); }
        @Bean AgentShareAudience audience(UserRelMapper relations, ObjectProvider<NodeRegistry> nodes) {
            return new AgentShareAudience(relations, nodes);
        }
        @Bean NodeRegistry nodes(AgentShareAudience presenceAudience) { return mock(NodeRegistry.class); }
    }
    @Test void presenceAudienceDoesNotEagerlyResolveTheRegistryDuringStartup() {
        try (var context = new AnnotationConfigApplicationContext(Wiring.class)) {
            var audience = context.getBean(AgentShareAudience.class);
            audience.changed("owner");
            verify(context.getBean(NodeRegistry.class)).broadcast(any(), any());
        }
    }
}
