import Foundation

/// Use `check` instead of `assert`: assert is stripped when compiling with `-O`, so tests would pretend to pass
@main struct MqttActivityStateTests {
    static var failures = 0

    static func check(_ condition: Bool, _ message: String = "", line: Int = #line) {
        if !condition {
            failures += 1
            FileHandle.standardError.write(Data("FAIL line \(line): \(message)\n".utf8))
        }
    }

    static func main() {
        var state = MqttActivityState()
        let start = Date(timeIntervalSince1970: 1000)
        func at(_ seconds: Double) -> Date { start.addingTimeInterval(seconds) }
        state.apply(conversationId: "task", agentUserId: "agent", busy: true, text: "first", sequence: 100, now: at(0))
        check(state.snapshot(now: at(1)).count == 1)
        state.apply(conversationId: "task", agentUserId: "agent", busy: true, text: nil, sequence: 200, now: at(10))
        check(state.snapshot(now: at(35)).first?.lines == ["first"], "heartbeat preserves lines and refreshes expiry")
        check(state.snapshot(now: at(40)).isEmpty, "30 seconds without fresh state expires busy")
        state.apply(conversationId: "task", agentUserId: "agent", busy: false, text: nil, sequence: 400, now: at(41))
        state.apply(conversationId: "task", agentUserId: "agent", busy: true, text: nil, sequence: 300, now: at(42))
        check(state.snapshot(now: at(43)).isEmpty, "late start cannot resurrect a stopped turn")
        state.apply(conversationId: "task", agentUserId: "agent", busy: true, text: nil, sequence: 500, now: at(50))
        state.apply(conversationId: "task", agentUserId: "agent", busy: true, text: nil, sequence: 500, now: at(79))
        check(state.snapshot(now: at(81)).isEmpty, "duplicate reports do not extend the lease")
        for i in 1...40 {
            state.apply(conversationId: "other", agentUserId: "agent", busy: nil, text: String(i), sequence: Double(600 + i), now: at(90))
        }
        check(state.snapshot(now: at(91)).first?.lines.count == 30)
        state.disconnect()
        check(state.snapshot(now: at(92)).isEmpty)
        state.apply(conversationId: "other", agentUserId: "agent", busy: true, text: nil, sequence: 601, now: at(93))
        check(state.snapshot(now: at(94)).isEmpty, "reconnect retains ordering tombstones")
        state.reset()
        state.apply(conversationId: "other", agentUserId: "agent", busy: true, text: nil, sequence: 1, now: at(95))
        check(state.snapshot(now: at(96)).count == 1, "new account starts with independent state")
        if failures > 0 {
            FileHandle.standardError.write(Data("\(failures) check(s) failed\n".utf8))
            exit(1)
        }
        print("iOS MQTT activity: heartbeat, expiry, event ordering, line bounds and reconnect passed")
    }
}
