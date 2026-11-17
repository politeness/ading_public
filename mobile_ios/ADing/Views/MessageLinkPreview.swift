import CoreFoundation
import CryptoKit
import LinkPresentation
import SwiftUI

/// One plain, adaptive card inside the message bubble; webpage branding cannot change its colors.
struct MessageLinkPreview: View {
    let url: URL
    @State private var preview: MessageLinkContent?

    init(url: URL) {
        self.url = url
        _preview = State(initialValue: MessageLinkMetadata.shared.cached(for: url))
    }

    private var title: String {
        [preview?.title, preview?.summary.title]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first(where: { !$0.isEmpty }) ?? url.host ?? url.absoluteString
    }

    var body: some View {
        Link(destination: url) {
            let site = preview?.summary.siteName ?? ""
            MessageLinkCard(title: title, summary: preview?.summary.description ?? "",
                            site: preview?.hasPageContent == true ? (site.isEmpty ? url.host ?? url.absoluteString : site) : url.absoluteString,
                            image: preview?.image.map { Image(uiImage: $0) })
        }
        .buttonStyle(.plain)
        .frame(maxWidth: 280, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .task(id: url) {
            let result = await MessageLinkMetadata.shared.preview(for: url)
            guard !Task.isCancelled else { return }
            preview = result
        }
    }
}

@MainActor private final class MessageLinkContent: NSObject {
    let title: String
    let summary: WebPageSummary
    let image: UIImage?
    var hasPageContent: Bool { !title.isEmpty || !summary.title.isEmpty || !summary.description.isEmpty }

    init(title: String, summary: WebPageSummary, image: UIImage?) {
        self.title = title; self.summary = summary; self.image = image
    }
}

/// Successful public-page previews survive view recreation and app restarts.
/// Failed requests are coalesced but remain retryable; no cookies or credentials are persisted.
@MainActor final class MessageLinkMetadata {
    static let shared = MessageLinkMetadata()
    private let cache = NSCache<NSURL, MessageLinkContent>()
    private var pending: [URL: Task<MessageLinkContent, Never>] = [:]
    private struct Stored: Codable {
        let title: String
        let summary: WebPageSummary
        let image: Data?
    }
    private let directory = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("message-link-previews-v1", isDirectory: true)

    private init() { cache.countLimit = 100 }

    private func file(for url: URL) -> URL {
        let key = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(key + ".json")
    }

    fileprivate func cached(for url: URL) -> MessageLinkContent? {
        if let cached = cache.object(forKey: url as NSURL) { return cached }
        guard let data = try? Data(contentsOf: file(for: url)),
              let stored = try? JSONDecoder().decode(Stored.self, from: data) else { return nil }
        let result = MessageLinkContent(title: stored.title, summary: stored.summary,
                                        image: stored.image.flatMap(UIImage.init(data:)))
        cache.setObject(result, forKey: url as NSURL)
        return result
    }

    func prefetch(_ contents: [String]) {
        let urls = Array(Set(contents.flatMap { MessageText.webURLs(in: MessageText.attributed($0)) })).prefix(20)
        Task { for url in urls { _ = await preview(for: url) } }
    }

    fileprivate func preview(for url: URL) async -> MessageLinkContent {
        if let cached = cached(for: url) { return cached }
        if let task = pending[url] { return await task.value }
        let task = Task<MessageLinkContent, Never> {
            async let summary = Self.pageSummary(for: url)
            let provider = LPMetadataProvider()
            provider.timeout = 12
            let metadata = try? await provider.startFetchingMetadata(for: url)
            var image: UIImage?
            if let provider = metadata?.imageProvider ?? metadata?.iconProvider {
                image = await withCheckedContinuation { continuation in
                    _ = provider.loadObject(ofClass: UIImage.self) { object, _ in
                        continuation.resume(returning: object as? UIImage)
                    }
                }
            }
            return await MessageLinkContent(title: metadata?.title ?? "", summary: summary, image: image)
        }
        pending[url] = task
        let result = await task.value
        pending[url] = nil
        if result.hasPageContent {
            cache.setObject(result, forKey: url as NSURL)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            // Store a bounded thumbnail rather than the original webpage image.
            let thumbnail = result.image.map { image in
                let ratio = min(1, 240 / max(image.size.width, image.size.height))
                return UIGraphicsImageRenderer(size: CGSize(width: max(1,image.size.width*ratio), height: max(1,image.size.height*ratio))).image { _ in
                    image.draw(in: CGRect(origin: .zero, size: CGSize(width: max(1,image.size.width*ratio), height: max(1,image.size.height*ratio))))
                }.jpegData(compressionQuality: 0.75)
            } ?? nil
            if let data = try? JSONEncoder().encode(Stored(title: result.title, summary: result.summary, image: thumbnail)) {
                try? data.write(to: file(for: url), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
            let files = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
            if files.count > 100 {
                let oldest = files.sorted { ((try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) < ((try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast) }
                for file in oldest.prefix(files.count-100) { try? FileManager.default.removeItem(at: file) }
            }
        }
        return result
    }

    /// Read only the page head, without browser cookies, credentials, scripts or page rendering.
    private nonisolated static func pageSummary(for url: URL) async -> WebPageSummary {
        guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
              url.user == nil, url.password == nil else { return WebPageSummary() }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpShouldSetCookies = false
        configuration.httpCookieStorage = nil
        configuration.urlCredentialStorage = nil
        configuration.timeoutIntervalForRequest = 6
        configuration.timeoutIntervalForResource = 8
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        do {
            var request = URLRequest(url: url)
            request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")
            let (stream, response) = try await session.bytes(for: request)
            guard let response = response as? HTTPURLResponse, response.statusCode == 200,
                  ["text/html", "application/xhtml+xml"].contains(response.mimeType?.lowercased() ?? "") else { return WebPageSummary() }
            var data = Data()
            data.reserveCapacity(64 * 1024)
            for try await byte in stream {
                data.append(byte)
                if data.count >= 256 * 1024 { break }
                if byte == 62, data.count >= 7,
                   String(decoding: data.suffix(7), as: UTF8.self).lowercased() == "</head>" { break }
            }
            var encoding = String.Encoding.utf8
            if let name = response.textEncodingName {
                let cf = CFStringConvertIANACharSetNameToEncoding(name as CFString)
                if cf != kCFStringEncodingInvalidId {
                    encoding = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(cf))
                }
            }
            return WebPageSummary.parse(String(data: data, encoding: encoding) ?? String(decoding: data, as: UTF8.self))
        } catch {
            return WebPageSummary()
        }
    }
}
