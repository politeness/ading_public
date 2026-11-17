package com.politeness.ading.conductor.common;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class SemVerTest {

    @Test
    void devBuildIsLowerThanSameNumberedRelease() {
        assertTrue(SemVer.compare("0.4.0-2026.9.16-235959-dev", "0.4.0") < 0);
        assertTrue(SemVer.compare("0.4.0", "0.4.0-2026.9.16-235959-dev") > 0);
    }

    @Test
    void devBuildsCompareByBuildDateNumerically() {
        assertTrue(SemVer.compare("0.4.0-2026.9.9-235959-dev", "0.4.0-2026.9.16-000000-dev") < 0);
        assertTrue(SemVer.compare("0.4.0-2026.10.1-000000-dev", "0.4.0-2026.9.30-235959-dev") > 0);
    }

    @Test
    void sameDayDevBuildsCompareByBuildTime() {
        assertTrue(SemVer.compare("0.4.0-2026.9.16-093005-dev", "0.4.0-2026.9.16-093006-dev") < 0);
        assertTrue(SemVer.compare("0.4.0-2026.9.16-095959-dev", "0.4.0-2026.9.16-100000-dev") < 0);
        assertTrue(SemVer.compare("0.4.0-2026.9.16-230000-dev", "0.4.0-2026.9.16-091500-dev") > 0);
        assertEquals(0, SemVer.compare("0.4.0-2026.9.16-093005-dev", "0.4.0-2026.9.16-093005-dev"));
        assertNotNull(SemVer.tryParse("0.4.0-2026.9.16-000000-dev"));
    }

    @Test
    void majorMinorPatchCompareNumerically() {
        assertTrue(SemVer.compare("0.10.0", "0.9.9") > 0);
        assertTrue(SemVer.compare("1.0.0", "0.99.99") > 0);
        assertEquals(0, SemVer.compare("0.4.0", "0.4.0+build.7"));
    }

    @Test
    void preReleaseSegmentRules() {
        assertTrue(SemVer.compare("1.0.0-alpha", "1.0.0-alpha.1") < 0);
        assertTrue(SemVer.compare("1.0.0-1", "1.0.0-alpha") < 0);
        assertTrue(SemVer.compare("1.0.0-beta.2", "1.0.0-beta.11") < 0);
    }

    @Test
    void invalidVersions() {
        assertThrows(IllegalArgumentException.class, () -> SemVer.parse("0.4"));
        assertThrows(IllegalArgumentException.class, () -> SemVer.parse("0.4.0-2026.09.16-093005-dev"));
        assertThrows(IllegalArgumentException.class, () -> SemVer.parse(null));
        assertNull(SemVer.tryParse("v0.4.0"));
    }
}
