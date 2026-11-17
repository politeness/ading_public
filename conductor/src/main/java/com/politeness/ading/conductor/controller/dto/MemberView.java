package com.politeness.ading.conductor.controller.dto;

public record MemberView(
        String userId,
        String displayName,
        boolean isAgent,
        String role,
        long lastReadSeq,
        /** Null means not recorded yet; fall back to lastReadSeq */
        Long lastProcessedSeq,
        /** The first unread message that @-mentions this person; null if none */
        Long firstUnreadMentionSeq,
        boolean paused,
        boolean resumeOnContinue,
        boolean ownerPaused) {
}
