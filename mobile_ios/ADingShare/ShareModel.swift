import Foundation
import Observation
import UIKit
import UniformTypeIdentifiers

/// "Share to ADing": send images, videos, files, links and text shared from other Apps into an ADing conversation.
///
/// The extension shares login state (SharedStore) and the networking layer with the App (Networking code is compiled into both targets),
/// so the sent message is identical to one sent in the App: ADing on the computer picks it up and hands it to the agent.
@MainActor
@Observable
final class ShareModel {
    enum Phase: Equatable {
        case loading
        case signedOut
        case ready
        case sending
        case failed(String)
    }

    var phase: Phase = .loading
    var attachments: [LocalAttachment] = []
    var text = ""
    var conversations: [RemoteConversation] = []
    enum Recipient: Equatable {
        case contact(String)
        case conversation(String)
    }

    var contacts: [RemoteUser] = []
    var selectedRecipient: Recipient?
    private var loadedRecipients = false
    private struct SendAttempt: Hashable {
        let conversationId: String
        let content: String
        let attachmentIds: [String]
    }
    private var sendAttempts: [SendAttempt: (messageId: String, attachments: [LocalAttachment])] = [:]

    var permanentConversations: [RemoteConversation] {
        conversations.filter { $0.permanent && !$0.isShared }
    }
    /// Some shared items weren't accepted (too large, unreadable, more than 9)
    var skipped: [String] = []

    private weak var context: NSExtensionContext?

    init(context: NSExtensionContext?) {
        self.context = context
    }

    var canSend: Bool {
        selectedRecipient != nil && phase == .ready
            && (!attachments.isEmpty || !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    func load() async {
        guard Credentials.accessToken != nil else {
            phase = .signedOut
            return
        }
        await readSharedItems()
        do {
            try await loadRecipients()
            phase = .ready
        } catch APIError.unauthorized {
            phase = .signedOut
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func send() async {
        guard let recipient = selectedRecipient, canSend else { return }
        phase = .sending
        do {
            let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
            let conversationId = try await resolveConversation(for: recipient, opening: content)
            // An unchanged retry is idempotent, including after a lost response.
            // Editing the message or choosing another conversation starts a new request.
            let attempt = SendAttempt(conversationId: conversationId, content: content,
                                      attachmentIds: attachments.map(\.attachmentId))
            let payload = sendAttempts[attempt] ?? (messageId: IDGenerator.message(), attachments: attachments.map {
                // Attachment IDs are also bound to one conversation and message on the server.
                LocalAttachment(attachmentId: IDGenerator.attachment(), fileURL: $0.fileURL,
                                name: $0.name, mimeType: $0.mimeType, size: $0.size)
            })
            sendAttempts[attempt] = payload
            _ = try await APIClient.shared.sendMessage(content, to: conversationId, messageId: payload.messageId, attachments: payload.attachments)
            attachments.forEach { $0.discard() }
            context?.completeRequest(returningItems: nil)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    func cancel() {
        attachments.forEach { $0.discard() }
        context?.cancelRequest(withError: CocoaError(.userCancelled))
    }

    /// After failure, return to a state where Send can be tapped again (attachments kept)
    func retry() async {
        if loadedRecipients {
            phase = .ready
            return
        }
        phase = .loading
        do {
            try await loadRecipients()
            phase = .ready
        } catch APIError.unauthorized {
            phase = .signedOut
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    private func loadRecipients() async throws {
        async let fetchedContacts = APIClient.shared.friends()
        async let fetchedConversations = APIClient.shared.conversations()
        let (people, chats) = try await (fetchedContacts, fetchedConversations)
        contacts = people.filter { $0.userId != Credentials.user?.userId }.sorted {
            if $0.isAgent != $1.isAgent { return $0.isAgent }
            return $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
        }
        conversations = chats.sorted {
            ($0.lastMessage?.gmtCreated ?? $0.gmtModified ?? .distantPast)
                > ($1.lastMessage?.gmtCreated ?? $1.gmtModified ?? .distantPast)
        }
        loadedRecipients = true
    }

    private func resolveConversation(for recipient: Recipient, opening: String) async throws -> String {
        switch recipient {
        case .conversation(let id):
            return id
        case .contact(let userId):
            if let existing = conversations.first(where: {
                !$0.isShared && $0.isDirect && $0.members.contains { $0.userId == userId }
            }) {
                return existing.conversationId
            }
            guard let me = Credentials.user?.userId else { throw APIError.unauthorized }
            let hasAgent = contacts.first { $0.userId == userId }?.isAgent == true
            let name = hasAgent ? "新会话" : String(opening.replacingOccurrences(of: "\n", with: " ").prefix(30))
            let created = try await APIClient.shared.createConversation(
                members: [.init(userId: me, role: "ENGINEER"), .init(userId: userId, role: "ENGINEER")],
                name: name, autoTitle: hasAgent)
            // On retry after an upload or send failure, reuse the conversation already created.
            conversations.insert(created, at: 0)
            return created.conversationId
        }
    }

    // MARK: Reading shared items

    private func readSharedItems() async {
        let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        var texts: [String] = []
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) == false,
               provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
               let url = try? await loadURL(provider) {
                // Web link: put it in the text; the agent opens it itself
                texts.append(url.absoluteString)
                continue
            }
            if !provider.hasFile, provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
               let string = try? await loadText(provider) {
                texts.append(string)
                continue
            }
            guard attachments.count < LocalAttachment.maxCount else {
                skipped.append(L10n.string("attachment.tooMany"))
                break
            }
            do {
                if let attachment = try await loadFile(provider) { attachments.append(attachment) }
            } catch {
                skipped.append(error.localizedDescription)
            }
        }
        text = texts.joined(separator: "\n")
    }

    private func loadURL(_ provider: NSItemProvider) async throws -> URL? {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: URL.self) { url, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: url) }
            }
        }
    }

    private func loadText(_ provider: NSItemProvider) async throws -> String? {
        try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: String.self) { string, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: string) }
            }
        }
    }

    /// Take as a file: the system's temp file is only valid inside the callback, so copy it out there
    private func loadFile(_ provider: NSItemProvider) async throws -> LocalAttachment? {
        guard let type = provider.preferredFileType else { return nil }
        let suggested = provider.suggestedName
        let attachment: LocalAttachment? = try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, error in
                if let url {
                    do {
                        let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "") : url.pathExtension
                        let name = suggested.map { ext.isEmpty || $0.hasSuffix(".\(ext)") ? $0 : "\($0).\(ext)" } ?? url.lastPathComponent
                        continuation.resume(returning: try LocalAttachment.copying(url, name: name))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                } else if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
        // Shared screenshots may only be an in-memory image without a file
        if attachment == nil, type.conforms(to: .image) {
            return try await loadImageData(provider)
        }
        return attachment.map(ShareModel.jpegIfHEIC)
    }

    private func loadImageData(_ provider: NSItemProvider) async throws -> LocalAttachment? {
        let image: UIImage? = try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadObject(ofClass: UIImage.self) { object, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: object as? UIImage) }
            }
        }
        guard let data = image?.jpegData(compressionQuality: 0.9) else { return nil }
        return try LocalAttachment.writing(data, name: "IMG_\(Int(Date().timeIntervalSince1970)).jpg")
    }

    /// Same as picking photos in the App: HEIC becomes JPEG so agents on the computer and desktop can open it directly
    private static func jpegIfHEIC(_ attachment: LocalAttachment) -> LocalAttachment {
        guard attachment.mimeType == "image/heic" || attachment.mimeType == "image/heif",
              let image = UIImage(contentsOfFile: attachment.fileURL.path),
              let jpeg = image.jpegData(compressionQuality: 0.9),
              let converted = try? LocalAttachment.writing(jpeg, name: (attachment.name as NSString).deletingPathExtension + ".jpg")
        else { return attachment }
        attachment.discard()
        return converted
    }
}

private extension NSItemProvider {
    /// Items to use as attachments: images, videos, PDFs and any other files (web links and plain text don't count)
    var preferredFileType: UTType? {
        let types = registeredTypeIdentifiers.compactMap(UTType.init)
        return types.first { $0.conforms(to: .movie) }
            ?? types.first { $0.conforms(to: .image) }
            ?? types.first { $0.conforms(to: .data) && !$0.conforms(to: .plainText) }
            ?? types.first { $0.conforms(to: .data) }
    }

    var hasFile: Bool {
        registeredTypeIdentifiers.compactMap(UTType.init).contains {
            $0.conforms(to: .image) || $0.conforms(to: .movie) || $0.conforms(to: .fileURL)
                || ($0.conforms(to: .data) && !$0.conforms(to: .text))
        }
    }
}
