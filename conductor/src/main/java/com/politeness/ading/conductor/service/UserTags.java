package com.politeness.ading.conductor.service;

/** Account tags (user_tags.tag). Allowlist-type capabilities hang off tags, so the list is maintained in one place and visible in the ops console. */
public final class UserTags {

    /** Can receive pre-release builds: the account itself and computers registered to it (including in standalone mode). */
    public static final String PRE_GRAY = "PRE_GRAY";
    /** Can still add friends from a mainland China IP. */
    public static final String MAINLAND_ADD_FRIEND = "MAINLAND_ADD_FRIEND";

    private UserTags() {
    }
}
