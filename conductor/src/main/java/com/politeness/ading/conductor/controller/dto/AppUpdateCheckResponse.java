package com.politeness.ading.conductor.controller.dto;

/**
 * Result of the update check. When no upgrade is available, available=false and update is empty.
 * (The global config does not output null fields, so an explicit available is used instead of making the client guess what an empty data means.)
 */
public record AppUpdateCheckResponse(boolean available, Update update) {

    public static AppUpdateCheckResponse none() {
        return new AppUpdateCheckResponse(false, null);
    }

    public static AppUpdateCheckResponse of(Update update) {
        return new AppUpdateCheckResponse(true, update);
    }

    public record Update(
            String version,
            String url,
            Long sizeBytes,
            String sha256,
            boolean signed,
            String teamId,
            /**
             * Forced upgrade: at least one of the versions higher than the current one is forced.
             * Not necessarily this version - when 0.8.0 is forced and 0.8.1 is not, a 0.7.0 client must still upgrade.
             */
            boolean mandatory,
            /** The minimum version that must be reached (the highest of those forced versions); empty when not forced */
            String requiredVersion,
            /** The current version is below minSupportedVersion, so incremental upgrade is not possible and the full package must be installed */
            boolean fullPackageRequired,
            /** This is a gray-release version (pushed only to listed accounts or computers) */
            boolean gray,
            String notes,
            String releasedAt) {
    }
}
