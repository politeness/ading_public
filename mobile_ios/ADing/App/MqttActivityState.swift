import Foundation

/// Short-lived execution state, ordered by the execution terminal's event sequence.
struct MqttActivityState {
    struct Entry {
        let conversationId: String
        let agentUserId: String
        var lines: [String] = []
    }
    private var active: [String: Entry] = [:]
    private var seen: [String: (sequence: Double, received: Date)] = [:]

    mutating func apply(conversationId: String, agentUserId: String, busy: Bool?, text: String?, sequence: Double?, now: Date = Date()) {
        let key = conversationId + "\n" + agentUserId
        let previous = seen[key]
        if let sequence, let previous, sequence <= previous.sequence { return }
        seen[key] = (sequence ?? previous?.sequence ?? 0, now)
        if busy == false { active.removeValue(forKey: key); return }
        var entry = active[key] ?? Entry(conversationId: conversationId, agentUserId: agentUserId)
        if let text, !text.isEmpty { entry.lines.append(text) }
        entry.lines = Array(entry.lines.suffix(30))
        active[key] = entry
    }
    mutating func snapshot(now: Date = Date()) -> [Entry] {
        active = active.filter { now.timeIntervalSince(seen[$0.key]?.received ?? .distantPast) < 30 }
        seen = seen.filter { now.timeIntervalSince($0.value.received) < 300 }
        return Array(active.values)
    }
    mutating func disconnect() { active.removeAll() }
    mutating func reset() { active.removeAll(); seen.removeAll() }
}
