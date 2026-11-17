package com.politeness.ading.ops.dal.mapper;

import java.util.Arrays;
import java.util.Locale;
import java.util.Properties;
import java.util.stream.Collectors;
import org.apache.ibatis.session.Configuration;

/**
 * Accounts excluded from statistics (e.g. app store review accounts). The list is not in the repo; it comes from the deployment's ADING_OPS_EXCLUDED_USERS,
 * comma-separated usernames; if unset, no account is excluded.
 *
 * The list is written into the SQL text when the Mapper is parsed (see {@link StatisticsScope#USERS}), so this must be called before addMapper,
 * and only letters, digits, underscores, dots and hyphens are accepted, to block splicing anything else into the SQL.
 */
public final class StatisticsExclusions {
    private StatisticsExclusions() {}

    static final String VARIABLE = "statisticsExcludedUsernames";

    public static void apply(Configuration configuration, String usernames) {
        String normalized = Arrays.stream((usernames == null ? "" : usernames).split(","))
                .map(name -> name.trim().toLowerCase(Locale.ROOT))
                .filter(name -> !name.isEmpty())
                .collect(Collectors.joining(","));
        if (!normalized.matches("[a-z0-9_.,-]*")) {
            throw new IllegalStateException("ADING_OPS_EXCLUDED_USERS must be comma-separated usernames (letters, digits, underscores, dots, hyphens)");
        }
        Properties variables = configuration.getVariables() == null ? new Properties() : configuration.getVariables();
        variables.setProperty(VARIABLE, normalized);
        configuration.setVariables(variables);
    }
}
