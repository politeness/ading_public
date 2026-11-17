package com.politeness.ading.conductor.common;

import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parsing and comparison of ADing version numbers (a subset of semver).
 *
 * Release {@code 0.4.0}, development build {@code 0.4.0-2026.9.16-093005-dev} (build date-hhmmss). Per semver precedence rules,
 * a version with a pre-release part is lower than the release with the same number: {@code 0.4.0-2026.9.16-093005-dev < 0.4.0}.
 * Pre-release parts are compared segment by segment: pure numbers compare numerically, segments starting with a digit compare the number first and then the rest as a string
 * ({@code 16-093005-dev} compares day 16 first, then the fixed-width hhmmss), others compare as strings,
 * pure-numeric segments are lower than string segments, and fewer segments is lower.
 * Build metadata (+xxx) does not take part in comparison.
 */
public record SemVer(int major, int minor, int patch, List<String> preRelease) implements Comparable<SemVer> {

    private static final Pattern PATTERN = Pattern.compile(
            "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)"
                    + "(?:-((?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*))*))?"
                    + "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$");

    public SemVer {
        preRelease = List.copyOf(preRelease);
    }

    public static SemVer parse(String text) {
        if (text == null) {
            throw new IllegalArgumentException("Version must not be empty");
        }
        Matcher m = PATTERN.matcher(text.trim());
        if (!m.matches()) {
            throw new IllegalArgumentException("Invalid version format: " + text);
        }
        try {
            return new SemVer(
                    Integer.parseInt(m.group(1)),
                    Integer.parseInt(m.group(2)),
                    Integer.parseInt(m.group(3)),
                    m.group(4) == null ? List.of() : List.of(m.group(4).split("\\.")));
        } catch (NumberFormatException e) {
            throw new IllegalArgumentException("Version number too large: " + text);
        }
    }

    /** Returns null on parse failure, for cases like "one badly written version in the database should not bring down the whole endpoint" */
    public static SemVer tryParse(String text) {
        try {
            return parse(text);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    public static int compare(String a, String b) {
        return parse(a).compareTo(parse(b));
    }

    @Override
    public int compareTo(SemVer other) {
        int c = Integer.compare(major, other.major);
        if (c != 0) return c;
        c = Integer.compare(minor, other.minor);
        if (c != 0) return c;
        c = Integer.compare(patch, other.patch);
        if (c != 0) return c;
        if (preRelease.isEmpty() || other.preRelease.isEmpty()) {
            // A release is higher than a pre-release; if both are releases they are equal
            return Boolean.compare(preRelease.isEmpty(), other.preRelease.isEmpty());
        }
        for (int i = 0; i < Math.min(preRelease.size(), other.preRelease.size()); i++) {
            c = compareIdentifier(preRelease.get(i), other.preRelease.get(i));
            if (c != 0) return c;
        }
        return Integer.compare(preRelease.size(), other.preRelease.size());
    }

    /**
     * One intentional difference from standard semver: for a "mixed segment starting with a digit" like {@code 16-dev},
     * the standard compares as strings and gets {@code 9-dev > 16-dev}, i.e. the dev build from the 9th is newer than the one from the 16th.
     * The last segment of ADing's dev version happens to be "day-dev", so here the leading number is compared first, then the rest.
     */
    private static int compareIdentifier(String a, String b) {
        boolean an = isNumeric(a);
        boolean bn = isNumeric(b);
        if (an && bn) {
            return compareDigits(a, b);
        }
        String ad = leadingDigits(a);
        String bd = leadingDigits(b);
        if (!ad.isEmpty() && !bd.isEmpty()) {
            int c = compareDigits(ad, bd);
            if (c != 0) return c;
            return a.substring(ad.length()).compareTo(b.substring(bd.length()));
        }
        if (an != bn) return an ? -1 : 1;
        return a.compareTo(b);
    }

    /** Compare length first to avoid overflow on very long numbers; semver forbids leading zeros, so length equals magnitude */
    private static int compareDigits(String a, String b) {
        return a.length() != b.length() ? Integer.compare(a.length(), b.length()) : a.compareTo(b);
    }

    private static String leadingDigits(String s) {
        int i = 0;
        while (i < s.length() && Character.isDigit(s.charAt(i))) i++;
        return s.substring(0, i);
    }

    private static boolean isNumeric(String s) {
        return !s.isEmpty() && s.chars().allMatch(Character::isDigit);
    }
}
