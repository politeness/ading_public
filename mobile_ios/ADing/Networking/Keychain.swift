import Foundation
import Security

/// Login tokens are stored in the keychain, available on this device only, not in iCloud backup.
/// Written to the keychain group shared by the App and share extension; reads don't specify a group, so items older versions wrote to the App's own group are still found.
enum Keychain {
    private static let service = "com.politeness.ading"

    static func read(_ account: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func write(_ value: String?, for account: String) {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        // No group specified: delete items in both the old and new groups
        SecItemDelete(base as CFDictionary)
        guard let value, let data = value.data(using: .utf8) else { return }
        var item = base
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        if let group = SharedStore.keychainGroup {
            var shared = item
            shared[kSecAttrAccessGroup as String] = group
            if SecItemAdd(shared as CFDictionary, nil) == errSecSuccess { return }
            // No shared-group capability (debug builds without entitlements): store in the App's own group; the App still works
        }
        SecItemAdd(item as CFDictionary, nil)
    }
}
