import Foundation
import Observation
import UIKit
import UserNotifications

/// System notifications: new messages received while the App is not in the foreground.
@MainActor
@Observable
final class PushNotifications {
    static let shared = PushNotifications()

    /// Conversation to open from a tapped notification; cleared after opening
    var pendingConversationId: String?

    @ObservationIgnored private var deviceToken: String?
    @ObservationIgnored private var userId: String?
    @ObservationIgnored private var deviceName = ""
    @ObservationIgnored private var badge: Int?

    /// Called every time we return to the foreground: the token or language may have changed, and the last report may have failed
    func sync(userId: String, deviceName: String) async {
        self.userId = userId
        self.deviceName = deviceName
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        // Pushes changed the icon badge while in background, so our recorded value is stale; set it again on next refresh
        badge = nil
        guard (try? await center.requestAuthorization(options: [.alert, .badge, .sound])) == true else { return }
        guard self.userId == userId else { return }
        UIApplication.shared.registerForRemoteNotifications()
        await upload()
    }

    func received(deviceToken: Data) {
        self.deviceToken = AppRules.hexString(deviceToken)
        Task { await upload() }
    }

    func setBadge(_ count: Int) {
        guard badge != count else { return }
        badge = count
        UNUserNotificationCenter.current().setBadgeCount(count)
    }

    func signedOut() {
        userId = nil
        badge = nil
        pendingConversationId = nil
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        center.setBadgeCount(0)
        let server = ServerEnvironment.current
        if let token = Keychain.read("pushNodeToken.\(server.rawValue)") {
            Task { await APIClient.shared.unregisterPushDevice(token: token, server: server) }
        }
    }

    private func upload() async {
        guard let deviceToken, userId != nil else { return }
        #if DEBUG
        let environment = "sandbox"
        #else
        // TestFlight (pre-release) and App Store both use production
        let environment = "production"
        #endif
        let language = AppRules.pushLanguage(AppLanguage.saved.localization ?? Bundle.main.preferredLocalizations.first)
        // No error shown on failure: report again next time we return to the foreground
        try? await APIClient.shared.registerPushDevice(deviceName: deviceName, appVersion: AppVersion.display, deviceToken: deviceToken, environment: environment, language: language)
    }
}

/// System callback entry point. Push callbacks only reach UIApplicationDelegate and the notification center delegate; SwiftUI has no equivalent
final class PushAppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        // Must be set before launch finishes, otherwise cold launches from a notification tap miss the callback
        UNUserNotificationCenter.current().delegate = self
        // Last logout couldn't reach the server: unregister again so we don't keep receiving the previous account's notifications
        if Credentials.user == nil {
            let server = ServerEnvironment.current
            if let token = Keychain.read("pushNodeToken.\(server.rawValue)") {
                Task { await APIClient.shared.unregisterPushDevice(token: token, server: server) }
            }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushNotifications.shared.received(deviceToken: deviceToken)
    }

    /// App in foreground: the new message is already shown in the UI, so no banner
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let conversationId = response.notification.request.content.userInfo["conversationId"] as? String
        Task { @MainActor in
            PushNotifications.shared.pendingConversationId = conversationId
            completionHandler()
        }
    }
}
