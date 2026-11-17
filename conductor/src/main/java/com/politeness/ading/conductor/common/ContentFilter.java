package com.politeness.ading.conductor.common;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * Banned-word filtering for messages between real people; the word list is in resources/content-filter/blocked-terms.txt.
 *
 * Two kinds of matching:
 *   - Pure English words match whole words (all non-alphanumerics are treated as separators first), so normal words containing them are not hit;
 *   - Words containing Chinese match as substrings, with whitespace, punctuation, and symbols removed first, so split spellings ("色 情", "色.情") are caught too.
 * Full-width/half-width and case are normalized first (NFKC + lowercase).
 */
public final class ContentFilter {

    private static final String RESOURCE = "/content-filter/blocked-terms.txt";
    private static final Pattern SEPARATORS = Pattern.compile("[\\s\\p{P}\\p{S}]+");
    private static final Pattern NON_WORD = Pattern.compile("[^\\p{L}\\p{N}]+");
    private static final Pattern ASCII = Pattern.compile("[\\x20-\\x7e]+");

    private static final List<String> WORD_TERMS = new ArrayList<>();
    private static final List<String> CJK_TERMS = new ArrayList<>();

    static {
        try (InputStream in = ContentFilter.class.getResourceAsStream(RESOURCE)) {
            if (in == null) throw new IllegalStateException("Missing banned-word list " + RESOURCE);
            BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8));
            for (String line; (line = reader.readLine()) != null; ) {
                String term = normalize(line.trim());
                if (term.isEmpty() || term.startsWith("#")) continue;
                if (ASCII.matcher(term).matches()) {
                    WORD_TERMS.add(" " + NON_WORD.matcher(term).replaceAll(" ").trim() + " ");
                } else {
                    CJK_TERMS.add(SEPARATORS.matcher(term).replaceAll(""));
                }
            }
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private ContentFilter() {
    }

    /** The first banned word hit; returns null if nothing is hit */
    public static String blockedTerm(String text) {
        if (text == null || text.isBlank()) return null;
        String normalized = normalize(text);
        String words = " " + NON_WORD.matcher(normalized).replaceAll(" ").trim() + " ";
        for (String term : WORD_TERMS) {
            if (words.contains(term)) return term.trim();
        }
        String compact = SEPARATORS.matcher(normalized).replaceAll("");
        for (String term : CJK_TERMS) {
            if (compact.contains(term)) return term;
        }
        return null;
    }

    private static String normalize(String text) {
        return Normalizer.normalize(text, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
    }
}
