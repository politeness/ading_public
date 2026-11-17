import Foundation
import Observation

/// Messages of one task. On open, fetch the latest messages, then pull incrementally by sequence number every two seconds:
/// once the agent on the computer writes its reply to the cloud, it shows up here. A draft has no task yet; pulling starts after the first message creates the task.
@MainActor
@Observable
final class ChatModel {
    private(set) var conversationId: String?
    var messages: [RemoteMessage] = [] {
        didSet {
            let previous = Set(oldValue.map(\.messageId))
            MessageLinkMetadata.shared.prefetch(messages.filter { $0.`internal` != true && !previous.contains($0.messageId) }.suffix(20).map(\.content))
        }
    }
    var sending = false
    var error: String?

    private var polling: Task<Void, Never>?
    private var lastRead = 0

    init(conversationId: String?) {
        self.conversationId = conversationId
    }

    /// Attach to the task once the draft becomes one, and start pulling
    func attach(_ conversationId: String) {
        self.conversationId = conversationId
        start()
    }

    var lastSeq: Int { messages.last?.seq ?? 0 }

    /// Show only conversation content; internal scheduling messages (those the desktop puts in "Activity") are hidden
    var visibleMessages: [RemoteMessage] {
        messages.filter { $0.`internal` != true }
    }

    func start() {
        guard polling == nil, conversationId != nil else { return }
        polling = Task { [weak self] in
            await self?.loadLatest()
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await self?.pull()
            }
        }
    }

    func stop() {
        polling?.cancel()
        polling = nil
    }

    private func loadLatest() async {
        guard let conversationId else { return }
        do {
            messages = try await APIClient.shared.latestMessages(in: conversationId)
            error = nil
            await markRead()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func pull() async {
        guard let conversationId else { return }
        do {
            let newer = try await APIClient.shared.messages(in: conversationId, afterSeq: lastSeq)
            merge(newer)
            error = nil
            await markRead()
        } catch {
            self.error = error.localizedDescription
        }
    }

    /// First message from a draft: createConversation creates the task first (attach once we have it), then send this message.
    /// Attachments may be sent without text; attachments are uploaded to OSS before the message is sent, so `sending` can last a while for large videos
    func send(_ text: String, attachments: [LocalAttachment] = [], mentions: [String] = [],
              replyTo: String? = nil, quote: MessageQuote? = nil,
              createConversation: (String) async throws -> String) async -> Bool {
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty || !attachments.isEmpty, !sending else { return false }
        sending = true
        defer { sending = false }
        do {
            let conversationId: String
            if let existing = self.conversationId {
                conversationId = existing
            } else {
                // Only attachments were sent: use attachment names for the task name and first message
                conversationId = try await createConversation(content.isEmpty ? attachments.map(\.name).joined(separator: "、") : content)
                attach(conversationId)
            }
            // Message IDs are generated on the phone: on network hiccups the same message is resent and the server dedupes by ID
            let message = try await APIClient.shared.sendMessage(content, to: conversationId, messageId: IDGenerator.message(),
                                                                 attachments: attachments, mentions: mentions,
                                                                 replyTo: replyTo, quote: quote)
            merge([message])
            attachments.forEach { $0.discard() }
            error = nil
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }

    private func merge(_ incoming: [RemoteMessage]) {
        guard !incoming.isEmpty else { return }
        var byId = Dictionary(uniqueKeysWithValues: messages.map { ($0.messageId, $0) })
        for message in incoming { byId[message.messageId] = message }
        messages = byId.values.sorted { $0.seq < $1.seq }
    }

    private func markRead() async {
        guard let conversationId else { return }
        let seq = lastSeq
        guard seq > lastRead else { return }
        do {
            try await APIClient.shared.markRead(conversationId, seq: seq)
            lastRead = max(lastRead, seq)
        } catch {
            // Keep the unacknowledged watermark and retry on the next poll so other terminals receive the read state.
        }
    }
}
