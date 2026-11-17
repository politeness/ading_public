import Foundation
import UniformTypeIdentifiers

/// An attachment to send: already copied into this App's temp directory (picked photos, picked files and shared-in items alike); can be deleted after sending.
/// Lives in Networking so the App and the share extension share one copy.
struct LocalAttachment: Identifiable, Hashable, Sendable {
    /// Same as the backend: 200 MB per file, at most 9 per message
    static let maxBytes: Int64 = 200 * 1024 * 1024
    static let maxCount = 9

    let attachmentId: String
    let fileURL: URL
    let name: String
    let mimeType: String
    let size: Int64

    var id: String { attachmentId }
    var isImage: Bool { mimeType.hasPrefix("image/") }
    var isVideo: Bool { mimeType.hasPrefix("video/") }

    enum Failure: LocalizedError {
        case tooLarge(String)
        case unreadable(String)

        var errorDescription: String? {
            switch self {
            case .tooLarge(let name): L10n.format("attachment.tooLarge %@", name)
            case .unreadable(let name): L10n.format("attachment.unreadable %@", name)
            }
        }
    }

    /// Copy a file in (picked in the Files app, or shared in). The original file is untouched
    static func copying(_ source: URL, name: String? = nil) throws -> LocalAttachment {
        let scoped = source.startAccessingSecurityScopedResource()
        defer { if scoped { source.stopAccessingSecurityScopedResource() } }
        let fileName = cleanName(name ?? source.lastPathComponent)
        let size = (try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? 0
        guard size <= maxBytes else { throw Failure.tooLarge(fileName) }
        let id = IDGenerator.attachment()
        let target = outgoingURL(id: id, name: fileName)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: source, to: target)
        } catch {
            throw Failure.unreadable(fileName)
        }
        let actual = (try? target.resourceValues(forKeys: [.fileSizeKey]).fileSize).map(Int64.init) ?? size
        guard actual <= maxBytes else {
            try? FileManager.default.removeItem(at: target.deletingLastPathComponent())
            throw Failure.tooLarge(fileName)
        }
        return LocalAttachment(attachmentId: id, fileURL: target, name: fileName, mimeType: mimeType(for: fileName), size: actual)
    }

    /// Content-only items without a file (photos from the photo library)
    static func writing(_ data: Data, name: String) throws -> LocalAttachment {
        let fileName = cleanName(name)
        guard Int64(data.count) <= maxBytes else { throw Failure.tooLarge(fileName) }
        let id = IDGenerator.attachment()
        let target = outgoingURL(id: id, name: fileName)
        do {
            try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: target)
        } catch {
            throw Failure.unreadable(fileName)
        }
        return LocalAttachment(attachmentId: id, fileURL: target, name: fileName, mimeType: mimeType(for: fileName), size: Int64(data.count))
    }

    /// Delete the temp file once sent (or removed by the user)
    func discard() {
        try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent())
    }

    static func mimeType(for name: String) -> String {
        let ext = (name as NSString).pathExtension
        return UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
    }

    /// Downloaded attachments go in the cache directory and can be purged when the system is low on space
    static func cacheURL(for attachment: RemoteAttachment) -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return caches.appendingPathComponent("attachments", isDirectory: true)
            .appendingPathComponent(safeComponent(attachment.attachmentId), isDirectory: true)
            .appendingPathComponent(cleanName(attachment.name))
    }

    private static func outgoingURL(id: String, name: String) -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("outgoing", isDirectory: true)
            .appendingPathComponent(id, isDirectory: true)
            .appendingPathComponent(name)
    }

    /// File names only drop path separators and control characters; Chinese characters are kept
    static func cleanName(_ name: String) -> String {
        let cleaned = name.components(separatedBy: CharacterSet(charactersIn: "/\\:").union(.controlCharacters))
            .joined(separator: "_")
            .trimmingCharacters(in: .whitespaces)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "file" : String(cleaned.prefix(200))
    }

    private static func safeComponent(_ value: String) -> String {
        value.filter { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "-" }
    }
}

extension Int64 {
    /// Attachment size, written like 1.2 MB
    var fileSizeText: String {
        ByteCountFormatter.string(fromByteCount: self, countStyle: .file)
    }
}
