package com.politeness.ading.ops.common;

/**
 * Wildcard escaping for LIKE fuzzy queries.
 *
 * Parameters are bound, so there's no injection; but a % or _ typed in the search box would act as a wildcard
 * and match the whole table. Only after escaping, together with ESCAPE '\\' in the SQL, is it a literal match.
 */
public final class LikePattern {

    private LikePattern() {
    }

    public static String contains(String keyword) {
        if (keyword == null) {
            return null;
        }
        String trimmed = keyword.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        StringBuilder escaped = new StringBuilder(trimmed.length() + 8);
        for (int i = 0; i < trimmed.length(); i++) {
            char c = trimmed.charAt(i);
            if (c == '\\' || c == '%' || c == '_') {
                escaped.append('\\');
            }
            escaped.append(c);
        }
        return "%" + escaped + "%";
    }
}
