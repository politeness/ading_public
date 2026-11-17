import Foundation
import SwiftUI

/// Use `check` instead of `assert`: assert is stripped when compiling with `-O`, so tests would pretend to pass
@main struct AppRulesTests {
    static var failures = 0

    static func check(_ condition: Bool, _ message: String, line: Int = #line) {
        if !condition {
            failures += 1
            FileHandle.standardError.write(Data("FAIL line \(line): \(message)\n".utf8))
        }
    }

    static func main() {
        var tracker = AppRules.ForegroundTracker()
        check(tracker.change(to: .inactive) == .none, "inactive at launch keeps the connection")
        check(tracker.change(to: .active) == .none, "launch is handled by the startup task")
        check(tracker.change(to: .inactive) == .none, "notification center does not disconnect")
        check(tracker.change(to: .active) == .none, "returning from inactive does not reconnect or refresh")
        check(tracker.change(to: .inactive) == .none, "app switcher does not disconnect")
        check(tracker.change(to: .background) == .leave, "background disconnects")
        check(tracker.change(to: .background) == .none, "repeated background is idempotent")
        check(tracker.change(to: .inactive) == .none, "inactive on the way back does nothing")
        check(tracker.change(to: .active) == .resume, "active after background reconnects and refreshes")
        check(tracker.change(to: .active) == .none, "resume happens once")

        check(AppRules.mqttRetryDelay(attempts: 0) == 1, "first retry after 1s")
        check(AppRules.mqttRetryDelay(attempts: 3) == 8, "exponential backoff")
        check(AppRules.mqttRetryDelay(attempts: 99) == 30, "backoff capped at 30s")
        check(AppRules.mqttDisabledRecheckSeconds >= 60, "disabled MQTT is rechecked slowly, not polled")

        let format: (String, String) -> String = { "\($0)'s \($1)" }
        check(AppRules.terminalName(deviceName: "iPhone", model: "iPhone", owner: "Alice", format: format) == "Alice's iPhone",
              "generic iOS 16+ name becomes the owner's device")
        check(AppRules.terminalName(deviceName: "iPad", model: "iPad", owner: "Alice", format: format) == "Alice's iPad",
              "iPad keeps its model")
        check(AppRules.terminalName(deviceName: "Alice 的 iPhone 15", model: "iPhone", owner: "Alice", format: format) == "Alice 的 iPhone 15",
              "user-assigned name is kept")
        check(AppRules.terminalName(deviceName: "iPhone", model: "iPhone", owner: "  ", format: format) == "iPhone",
              "blank owner falls back to the model")

        let owners = ["c": "A", "q": "D"]
        check(AppRules.withAgentOwners(["c"], currentUser: "B", owners: owners) == ["c", "A"], "shared Agent brings owner")
        check(AppRules.withAgentOwners(["c", "A"], currentUser: "B", owners: owners) == ["c", "A"], "owner is not duplicated")
        check(AppRules.withAgentOwners(["c"], currentUser: "A", owners: owners) == ["c"], "current user already participates")
        check(AppRules.canJoin(["c"], currentUser: "B", owners: owners, shares: ["c": ["B"]]), "shared Agent with owner is allowed")
        check(!AppRules.canJoin(["c", "stranger"], currentUser: "B", owners: owners, shares: ["c": ["B"]]), "ungranted human is blocked")
        check(!AppRules.canJoin(["c", "q"], currentUser: "B", owners: owners, shares: ["c": ["B"], "q": ["B"]]), "both owners need cross grants")
        check(AppRules.canJoin(["c", "q"], currentUser: "B", owners: owners, shares: ["c": ["B", "D"], "q": ["B", "A"]]), "cross-granted group is allowed")
        for shared in [true, false] {
            for permanent in [true, false] {
                check(AppRules.showsConversation(shared: shared, permanent: permanent, sharedOnly: false, permanentOnly: false), "no filters shows all")
                check(AppRules.showsConversation(shared: shared, permanent: permanent, sharedOnly: true, permanentOnly: false) == shared, "shared category")
                check(AppRules.showsConversation(shared: shared, permanent: permanent, sharedOnly: false, permanentOnly: true) == (!shared && permanent), "permanent category excludes shared")
                check(AppRules.showsConversation(shared: shared, permanent: permanent, sharedOnly: true, permanentOnly: true) == (shared || permanent), "both categories form a union")
            }
        }

        check(AppRules.hexString(Data([0x00, 0xab, 0xff])) == "00abff", "device token is lowercase hex, leading zeros kept")
        check(AppRules.pushLanguage("zh-Hans") == "zh", "Chinese localization")
        check(AppRules.pushLanguage("en") == "en", "English localization")
        check(AppRules.pushLanguage(nil) == "en", "unknown language falls back to English")

        if failures > 0 {
            FileHandle.standardError.write(Data("\(failures) check(s) failed\n".utf8))
            exit(1)
        }
        print("iOS app rules: foreground lifecycle, MQTT retry, terminal name and member mixing passed")
    }
}
