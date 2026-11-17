import Foundation

/// Storage shared by the App and the "Share to ADing" extension.
///
/// The extension is a separate process with a separate sandbox: login tokens live in a shared keychain group, and the current user and server environment live in the App Group's UserDefaults,
/// so tapping "Share → ADing" in another App doesn't require logging in again.
/// Both names must match the entitlements and what was created in the developer portal (see "Share extension" in mobile_ios/README.md).
enum SharedStore {
    static let appGroup = "group.com.politeness.ading"

    /// Without an App Group (debug builds lacking the capability), fall back to the App's own; the App still works, only the extension can't read it
    static let defaults: UserDefaults = UserDefaults(suiteName: appGroup) ?? .standard

    /// Shared keychain group with the Team prefix. Set in Info.plist's AdingKeychainGroup, filled with $(AppIdentifierPrefix) at build time
    static var keychainGroup: String? {
        guard let group = Bundle.main.object(forInfoDictionaryKey: "AdingKeychainGroup") as? String,
              !group.isEmpty, !group.hasPrefix("$(") else { return nil }
        return group
    }

    /// Values previously stored in the App's own UserDefaults: read once and move to the shared one
    static func migrated(_ key: String) -> Data? {
        if let data = defaults.data(forKey: key) { return data }
        guard defaults !== UserDefaults.standard, let old = UserDefaults.standard.data(forKey: key) else { return nil }
        defaults.set(old, forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
        return old
    }

    static func migratedString(_ key: String) -> String? {
        if let value = defaults.string(forKey: key) { return value }
        guard defaults !== UserDefaults.standard, let old = UserDefaults.standard.string(forKey: key) else { return nil }
        defaults.set(old, forKey: key)
        UserDefaults.standard.removeObject(forKey: key)
        return old
    }
}
