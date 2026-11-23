import Foundation

// Isolated API and preview doubles; the real ChatModel and message types are compiled below.
struct LocalAttachment { let name: String; func discard() {} }
@MainActor final class MessageLinkMetadata {
    static let shared = MessageLinkMetadata()
    func prefetch(_ content: [String]) {}
}
@MainActor final class APIClient {
    static let shared = APIClient()
    var source: [RemoteMessage] = []
    var requests: [(after: Int?, before: Int?)] = []
    var failure = false
    var gate: CheckedContinuation<Void, Never>?
    var suspendNext = false
    func page(after: Int? = nil, before: Int? = nil) async throws -> [RemoteMessage] {
        requests.append((after, before))
        if suspendNext { suspendNext = false; await withCheckedContinuation { gate = $0 } }
        if failure { failure = false; throw URLError(.notConnectedToInternet) }
        if let after { return Array(source.filter { $0.seq > after }.prefix(100)) }
        if let before { return Array(source.filter { $0.seq < before }.suffix(100)) }
        return Array(source.suffix(100))
    }
    func latestMessages(in id: String) async throws -> [RemoteMessage] { try await page() }
    func messages(in id: String, afterSeq: Int) async throws -> [RemoteMessage] { try await page(after: afterSeq) }
    func messages(in id: String, beforeSeq: Int) async throws -> [RemoteMessage] { try await page(before: beforeSeq) }
    func markRead(_ id: String, seq: Int) async throws {}
    func sendMessage(_ content: String, to: String, messageId: String, attachments: [LocalAttachment], mentions: [String], replyTo: String?, quote: MessageQuote?) async throws -> RemoteMessage { source.last! }
}

@main struct ChatHistoryTests {
    @MainActor static func main() async throws {
        var checks = 0
        func check(_ value: @autoclosure () -> Bool, _ label: String) {
            guard value() else { fatalError(label) }; checks += 1
        }
        func rows(_ through: Int) throws -> [RemoteMessage] {
            try (1...through).map { seq in
                let json = "{\"messageId\":\"m\(seq)\",\"conversationId\":\"test\",\"seq\":\(seq),\"senderId\":\"sender\",\"content\":\"message \(seq)\",\"type\":\"USER\"}"
                return try JSONDecoder().decode(RemoteMessage.self, from: Data(json.utf8))
            }
        }
        let api = APIClient.shared
        api.source = try rows(251)
        let chat = ChatModel(conversationId: "test")
        await chat.pull()
        check(chat.messages.count == 100 && chat.messages.first?.seq == 152, "latest page is 100")
        check(chat.hasOlder, "older pages available")
        api.failure = true
        await chat.loadOlder()
        check(chat.messages.count == 100 && chat.hasOlder && !chat.loadingOlder, "failed page can retry without losing data")
        api.suspendNext = true
        let older = Task { await chat.loadOlder() }
        while api.gate == nil { await Task.yield() }
        let count = api.requests.count
        await chat.loadOlder()
        check(api.requests.count == count, "one history request in flight")
        api.source = try rows(252)
        await chat.pull()
        api.gate?.resume(); api.gate = nil
        await older.value
        check(chat.messages.count == 201 && chat.lastSeq == 252 && chat.messages.first?.seq == 52, "prepend preserves concurrent arrivals")
        await chat.loadOlder()
        check(chat.messages.count == 252 && !chat.hasOlder, "partial final page completes history")
        let finalCount = api.requests.count
        await chat.loadOlder()
        check(api.requests.count == finalCount, "no request after end")
        check(Set(chat.messages.map(\.messageId)).count == chat.messages.count, "no duplicate messages")

        api.failure = true
        let retry = ChatModel(conversationId: "retry")
        await retry.pull(); await retry.pull()
        check(retry.messages.first?.seq == 153, "initial retry loads latest, not oldest")
        api.suspendNext = true
        let late = Task { await retry.loadOlder() }
        while api.gate == nil { await Task.yield() }
        retry.stop()
        api.gate?.resume(); api.gate = nil
        await late.value
        check(retry.messages.count == 100 && !retry.loadingOlder, "stopped view ignores late page")
        await retry.loadOlder()
        check(retry.messages.count == 200, "history resumes after stop")
        print("ChatHistoryTests: \(checks) checks passed")
    }
}
