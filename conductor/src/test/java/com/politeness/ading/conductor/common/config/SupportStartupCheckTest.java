package com.politeness.ading.conductor.common.config;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

/**
 * Environments are distinguished by profile: prod is ECS on the internal network, dev is NAS on the public internet.
 * If swapped, it must be visible immediately in the startup log.
 */
class SupportStartupCheckTest {

    private static final String PUBLIC = "https://oss-cn-shanghai.aliyuncs.com";
    private static final String INTERNAL = "https://oss-cn-shanghai-internal.aliyuncs.com";

    /**
     * Uploads use the internal network, but links are opened by people on the public internet: internal domains do not resolve outside the VPC at all,
     * so signed links must use the public domain.
     */
    @Test
    void publicEndpointDropsTheInternalMarker() {
        AdingProperties.Support support = new AdingProperties().getSupport();
        support.setOssEndpoint(INTERNAL);
        assertEquals(PUBLIC, support.resolvedOssPublicEndpoint());
    }

    @Test
    void publicEndpointIsLeftAloneWhenAlreadyPublic() {
        AdingProperties.Support support = new AdingProperties().getSupport();
        support.setOssEndpoint(PUBLIC);
        assertEquals(PUBLIC, support.resolvedOssPublicEndpoint());
    }

    @Test
    void anExplicitPublicEndpointWins() {
        AdingProperties.Support support = new AdingProperties().getSupport();
        support.setOssEndpoint(INTERNAL);
        support.setOssPublicEndpoint("https://cdn.example.com");
        assertEquals("https://cdn.example.com", support.resolvedOssPublicEndpoint());
    }

    @Test
    void matchingEndpointsRaiseNothing() {
        assertNull(SupportStartupCheck.endpointWarning(true, INTERNAL));
        assertNull(SupportStartupCheck.endpointWarning(false, PUBLIC));
    }

    @Test
    void productionOnThePublicEndpointIsCalledOut() {
        String warning = SupportStartupCheck.endpointWarning(true, PUBLIC);
        assertTrue(warning != null && warning.contains("internal network"), warning);
    }

    @Test
    void developmentOnTheInternalEndpointIsCalledOut() {
        String warning = SupportStartupCheck.endpointWarning(false, INTERNAL);
        assertTrue(warning != null && warning.contains("VPC"), warning);
    }

    /** With no endpoint configured, the support service itself returns 503, so no duplicate warning here. */
    @Test
    void missingEndpointIsNotThisCheckersProblem() {
        assertNull(SupportStartupCheck.endpointWarning(true, ""));
        assertNull(SupportStartupCheck.endpointWarning(true, null));
    }
}
