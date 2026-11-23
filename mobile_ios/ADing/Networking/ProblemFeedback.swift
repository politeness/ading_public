import Foundation

private enum FeedbackStorage {
    static func write(_ data: Data, to url: URL) throws {
        #if os(iOS)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUnlessOpen])
        #else
        // iOS data protection produces files a macOS command-line host cannot reopen.
        try data.write(to: url, options: [.atomic])
        #endif
    }
}

struct FeedbackImage: Codable, Identifiable, Sendable {
    let name: String
    let mimeType: String
    let dataUrl: String
    var id: String { name }
    var bytes: Data? { dataUrl.split(separator: ",", maxSplits: 1).last.flatMap { Data(base64Encoded: String($0)) } }
    init(name: String, jpeg: Data) {
        self.name = name; mimeType = "image/jpeg"
        dataUrl = "data:image/jpeg;base64," + jpeg.base64EncodedString()
    }
}

struct ProblemFeedback: Codable, Sendable {
    struct Log: Codable, Sendable { let name: String; let content: String }
    struct Context: Codable, Sendable {
        let appVersion: String
        let platform: String
        let arch: String
        let mode: String
        let logs: [Log]
        let userId: String?
        let terminalId: String
    }
    var schemaVersion = 3
    let reportId: String
    let createdAt: String
    let occurredAt: String
    let description: String
    let screenshot: FeedbackImage?
    let images: [FeedbackImage]
    let context: Context

    enum Failure: String, LocalizedError {
        case description = "feedback.invalidDescription"
        case images = "feedback.invalidImages"
        case response = "feedback.invalidResponse"
        var errorDescription: String? { L10n.string(rawValue) }
    }
    func validate() throws {
        guard (5...4000).contains(description.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) else { throw Failure.description }
        let all = images + (screenshot.map { [$0] } ?? [])
        guard images.count <= 5, all.allSatisfy({ image in
            image.mimeType == "image/jpeg" && image.dataUrl.hasPrefix("data:image/jpeg;base64,") && (image.bytes.map { !$0.isEmpty && $0.count <= 5 * 1024 * 1024 } ?? false)
        }), all.reduce(0, { $0 + ($1.bytes?.count ?? 0) }) <= 15 * 1024 * 1024 else { throw Failure.images }
        guard context.logs.count <= 2, context.logs.allSatisfy({ $0.content.utf8.count <= 1024 * 1024 }) else { throw Failure.response }
    }
}

enum FeedbackDelivery: Equatable { case submitted, queued, rejected(String) }

/// Same self-contained outbox and public report endpoint as desktop. Only an
/// explicit Submit enqueues content; startup/foreground only retry that content.
actor ProblemFeedbackQueue {
    typealias Transport = @Sendable (URLRequest) async throws -> (Data, URLResponse)
    static let shared = ProblemFeedbackQueue(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("feedback"))
    private struct Pending: Codable { let endpoint: URL; let payload: ProblemFeedback }
    private let directory: URL
    private let transport: Transport
    private var active: Set<String> = []
    private var flushing = false
    init(directory: URL, transport: @escaping Transport = { try await URLSession.shared.data(for: $0) }) {
        self.directory = directory; self.transport = transport
    }
    func enqueue(_ payload: ProblemFeedback, baseURL: URL) throws {
        try payload.validate()
        guard ["http", "https"].contains(baseURL.scheme), baseURL.user == nil, baseURL.password == nil,
              UUID(uuidString: String(payload.reportId.dropFirst(7))) != nil, payload.reportId.hasPrefix("report_") else { throw ProblemFeedback.Failure.response }
        let pending = directory.appendingPathComponent("pending")
        try FileManager.default.createDirectory(at: pending, withIntermediateDirectories: true)
        let entry = Pending(endpoint: baseURL.appendingPathComponent("api/v1/support/reports"), payload: payload)
        try FeedbackStorage.write(JSONEncoder().encode(entry), to: pending.appendingPathComponent(payload.reportId + ".json"))
    }
    func upload(_ reportId: String) async -> FeedbackDelivery {
        guard !active.contains(reportId) else { return .queued }
        active.insert(reportId); defer { active.remove(reportId) }
        let file = directory.appendingPathComponent("pending").appendingPathComponent(reportId + ".json")
        do {
            let pending = try JSONDecoder().decode(Pending.self, from: Data(contentsOf: file))
            var request = URLRequest(url: pending.endpoint)
            request.httpMethod = "POST"; request.timeoutInterval = 60
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(pending.payload)
            let (data, raw) = try await transport(request)
            let status = (raw as? HTTPURLResponse)?.statusCode ?? 0
            struct Receipt: Decodable { let reportId: String; let status: String }
            struct Envelope: Decodable { let code: String; let message: String?; let data: Receipt? }
            let envelope = try? JSONDecoder().decode(Envelope.self, from: data)
            if (200..<300).contains(status), envelope?.code == "OK", envelope?.data?.reportId == reportId,
               ["uploaded", "duplicate"].contains(envelope?.data?.status ?? "") {
                try FileManager.default.removeItem(at: file)
                return .submitted
            }
            let permanent = ((400..<500).contains(status) && status != 408 && status != 429) || ((200..<300).contains(status) && envelope?.code != nil && envelope?.code != "OK")
            if permanent {
                let failed = directory.appendingPathComponent("failed")
                try FileManager.default.createDirectory(at: failed, withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: file, to: failed.appendingPathComponent(file.lastPathComponent))
                // The server message is English only; show the localized text for the code
                return .rejected(envelope.map { L10n.optional("server.error.\($0.code)") ?? L10n.string("error.requestFailed") } ?? L10n.string("feedback.invalidResponse"))
            }
            return .queued
        } catch { return .queued }
    }
    func flush() async {
        guard !flushing else { return }; flushing = true; defer { flushing = false }
        let files = (try? FileManager.default.contentsOfDirectory(at: directory.appendingPathComponent("pending"), includingPropertiesForKeys: nil)) ?? []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) where file.pathExtension == "json" {
            if Task.isCancelled { return }
            _ = await upload(file.deletingPathExtension().lastPathComponent)
        }
    }
}

/// Bounded 48-hour diagnostics, isolated by account and server. Call sites record
/// only fixed events, status/error codes and counts; never message bodies, URLs,
/// headers, credentials or server response text.
actor FeedbackDiagnostics {
    static let shared = FeedbackDiagnostics(directory: FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("feedback-diagnostics"))
    struct Scope: Sendable {
        let owner: String?
        let environment: String
        var filename: String { (environment + "_" + (owner ?? "anonymous")).map { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_" || $0 == "-") ? String($0) : "_" }.joined() + ".json" }
    }
    private struct Event: Codable { let time: Date; let event: String; let fields: [String: String] }
    private let directory: URL
    init(directory: URL) { self.directory = directory }
    private func events(_ scope: Scope, now: Date) -> [Event] {
        let entries = (try? JSONDecoder().decode([Event].self, from: Data(contentsOf: directory.appendingPathComponent(scope.filename)))) ?? []
        return Array(entries.filter { $0.time >= now.addingTimeInterval(-48 * 3600) }.suffix(1000))
    }
    func record(_ event: String, fields: [String: String] = [:], scope: Scope, now: Date = Date()) {
        let allowed = Set(["method", "route", "status", "code", "domain", "version", "platform", "state"])
        let safe = fields.filter { allowed.contains($0.key) }.mapValues { String($0.prefix(160)) }
        var entries = events(scope, now: now)
        entries.append(Event(time: now, event: String(event.prefix(80)), fields: safe))
        entries = Array(entries.suffix(1000))
        guard let data = try? JSONEncoder().encode(entries) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FeedbackStorage.write(data, to: directory.appendingPathComponent(scope.filename))
    }
    func snapshot(_ scope: Scope, now: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        let lines = events(scope, now: now).compactMap { event -> String? in
            let value: [String: Any] = ["time": formatter.string(from: event.time), "event": event.event, "fields": event.fields]
            return (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])).flatMap { String(data: $0, encoding: .utf8) }
        }
        var bytes = 0
        var kept: [String] = []
        for line in lines.reversed() {
            guard bytes + line.utf8.count + 1 <= 512 * 1024 else { break }
            kept.append(line); bytes += line.utf8.count + 1
        }
        return kept.reversed().joined(separator: "\n")
    }
}
