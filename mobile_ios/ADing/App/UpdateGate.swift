import Foundation
import Observation

/// Forced update: when the server says the current version must be updated first, block the whole App.
/// Release builds go through the App Store; TestFlight pre-release builds get updates distributed by Apple to test groups.
///
/// The required version is stored locally: going offline or killing and reopening can't bypass it; only the server's verdict lifts it —
/// it is cleared only when the server says "no update" or "update available but not forced" (forced version withdrawn); unchanged when the check fails.
@MainActor
@Observable
final class UpdateGate {
    private static let key = "requiredAppVersion"

    /// Minimum version that must be reached; empty means normal use
    private(set) var requiredVersion: String?
    /// Update link, provided by the server; may be a TestFlight invite link for pre-release builds.
    private(set) var updateURL: URL?
    private(set) var checking = false
    private(set) var lastError: String?

    let currentVersion = AppVersion.display

    init() {
        if let saved = UserDefaults.standard.string(forKey: Self.key), AppVersion.isNewer(saved, than: currentVersion) {
            requiredVersion = saved
        } else {
            UserDefaults.standard.removeObject(forKey: Self.key)
        }
    }

    func check() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }
        do {
            let result = try await APIClient.shared.checkUpdate(currentVersion: currentVersion)
            lastError = nil
            let update = result.available ? result.update : nil
            updateURL = update?.url.flatMap(URL.init(string:)).flatMap { $0.scheme == "https" ? $0 : nil }
            let wanted = update?.mandatory == true ? update?.requiredVersion : nil
            requiredVersion = wanted.flatMap { AppVersion.isNewer($0, than: currentVersion) ? $0 : nil }
            if let requiredVersion {
                UserDefaults.standard.set(requiredVersion, forKey: Self.key)
            } else {
                UserDefaults.standard.removeObject(forKey: Self.key)
            }
        } catch {
            lastError = error.localizedDescription
        }
    }

}
