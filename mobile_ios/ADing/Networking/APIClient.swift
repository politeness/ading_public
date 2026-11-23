import Foundation

enum APIError: LocalizedError {
    /// Explicitly rejected by the server, with the backend error code and message
    case rejected(code: String, message: String)
    /// Login expired and refreshing didn't recover it; need to log in again
    case unauthorized
    /// Can't reach the server
    case network(String)

    /// Codes thrown by APIClient itself (HTTP status, upload and download failures), never sent by the server
    static let clientCodePrefixes = ["HTTP_", "UPLOAD_", "DOWNLOAD_", "BAD_", "EMPTY"]

    var errorDescription: String? {
        switch self {
        // Codes with app-specific wording
        case .rejected("MSG_009", _): L10n.string("error.contentBlocked")
        case .rejected("REGION_001", _): L10n.string("error.regionUnavailable")
        case .rejected("AGENT_009", _): L10n.string("agent.computerOffline")
        case .rejected("NODE_006", _): L10n.string("error.presenceUnknown")
        // Codes made by this client carry already localized text. Server codes: the server message is
        // English only, so show the localized text for the code
        case .rejected(let code, let message):
            if APIError.clientCodePrefixes.contains(where: code.hasPrefix) {
                message
            } else {
                L10n.optional("server.error.\(code)") ?? L10n.string("error.requestFailed")
            }
        case .unauthorized: L10n.string("error.unauthorized")
        case .network(let detail): L10n.format("error.network %@", detail)
        }
    }
}

/// Calls conductor's REST API. When the access token expires, exchange the refresh token once and retry; if refreshing also fails, go back to login.
actor APIClient {
    static let shared = APIClient()

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder = JSONEncoder()
    private var refreshing: Task<Bool, Error>?
    /// Notify the UI to return to the login page when login expires
    nonisolated(unsafe) var onUnauthorized: (@Sendable () -> Void)?

    init(session: URLSession? = nil) {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 20
        self.session = session ?? URLSession(configuration: configuration)
        decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            if let date = APIClient.isoFractional.date(from: text) ?? APIClient.iso.date(from: text) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "bad date \(text)"))
        }
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let iso = ISO8601DateFormatter()

    var baseURL: URL { ServerEnvironment.current.baseURL }

    // MARK: Account

    func login(username: String, password: String) async throws -> TokenResponse {
        struct Body: Encodable { let username: String; let password: String }
        let tokens: TokenResponse = try await send("POST", "/api/v1/auth/login", body: Body(username: username, password: password), authorized: false)
        Credentials.save(tokens)
        return tokens
    }

    /// Keep user REST credentials separate from the terminal token used to obtain MQTT access.
    func mqttCredentials(deviceName: String, appVersion: String) async throws -> MqttCredentials {
        let owner = Credentials.user?.userId
        let environment = ServerEnvironment.current
        let terminal = try await registerTerminal(deviceName: deviceName, appVersion: appVersion)
        guard owner != nil, Credentials.user?.userId == owner, environment == ServerEnvironment.current else {
            throw APIError.unauthorized
        }
        var request = URLRequest(url: URL(string: baseURL.absoluteString + "/api/v1/mqtt/credentials")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(terminal.nodeToken)", forHTTPHeaderField: "Authorization")
        let (data, response) = try await session.data(for: request)
        let result = try decoder.decode(APIEnvelope<MqttCredentials>.self, from: data)
        guard (response as? HTTPURLResponse)?.statusCode == 200, result.code == "OK", let credentials = result.data else {
            throw APIError.rejected(code: result.code, message: result.message ?? result.code)
        }
        guard Credentials.user?.userId == owner, environment == ServerEnvironment.current else { throw APIError.unauthorized }
        return credentials
    }

    private func registerTerminal(deviceName: String, appVersion: String) async throws -> TerminalRegistration {
        let fingerprint: String
        if let saved = Keychain.read("terminalFingerprint") { fingerprint = saved }
        else {
            fingerprint = UUID().uuidString
            Keychain.write(fingerprint, for: "terminalFingerprint")
            guard Keychain.read("terminalFingerprint") == fingerprint else {
                throw APIError.network(L10n.string("error.terminalIdentity"))
            }
        }
        struct Registration: Encodable {
            let fingerprint: String
            let name: String
            let type = "MOBILE"
            let appVersion: String
            let osVersion: String
        }
        let system = ProcessInfo.processInfo.operatingSystemVersion
        // Re-registration is idempotent.
        return try await send("POST", "/api/v1/terminals/register", body: Registration(
            fingerprint: fingerprint, name: deviceName, appVersion: appVersion,
            osVersion: "iOS \(system.majorVersion).\(system.minorVersion).\(system.patchVersion)"))
    }

    // MARK: Push

    /// The terminal token stays in the keychain: it is still needed to unregister after logout or user token expiry
    func registerPushDevice(deviceName: String, appVersion: String, deviceToken: String, environment: String, language: String) async throws {
        struct Body: Encodable {
            let deviceToken: String
            let environment: String
            let language: String
        }
        let server = ServerEnvironment.current
        let tokenKey = "pushNodeToken.\(server.rawValue)"
        let owner = Credentials.user?.userId
        let terminal = try await registerTerminal(deviceName: deviceName, appVersion: appVersion)
        guard owner != nil, Credentials.user?.userId == owner, ServerEnvironment.current == server else { throw APIError.unauthorized }
        Keychain.write(terminal.nodeToken, for: tokenKey)
        let status = try await sendAsTerminal("PUT", server: server, token: terminal.nodeToken,
                                              body: try encoder.encode(Body(deviceToken: deviceToken, environment: environment, language: language)))
        // Logged out mid-report: the unregister may have arrived first, so unregister again here to stop receiving the previous account's notifications
        guard Credentials.user?.userId == owner, ServerEnvironment.current == server else {
            _ = try? await sendAsTerminal("DELETE", server: server, token: terminal.nodeToken, body: nil)
            throw APIError.unauthorized
        }
        guard status == 200 else { throw APIError.rejected(code: "HTTP_\(status)", message: L10n.format("error.badResponse %lld", status)) }
    }

    /// Keep the token when unreachable and retry on next launch; a 401 means the token is invalid and the server already removed this phone when revoking it
    func unregisterPushDevice(token: String, server: ServerEnvironment) async {
        let tokenKey = "pushNodeToken.\(server.rawValue)"
        guard let status = try? await sendAsTerminal("DELETE", server: server, token: token, body: nil),
              status == 200 || status == 401 else { return }
        if Keychain.read(tokenKey) == token { Keychain.write(nil, for: tokenKey) }
    }

    private func sendAsTerminal(_ method: String, server: ServerEnvironment, token: String, body: Data?) async throws -> Int {
        var request = URLRequest(url: URL(string: server.baseURL.absoluteString + "/api/v1/terminals/me/push-device")!)
        request.httpMethod = method
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (_, response) = try await session.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    // MARK: Data

    func friends() async throws -> [RemoteUser] {
        try await send("GET", "/api/v1/friends")
    }

    func conversations() async throws -> [RemoteConversation] {
        try await send("GET", "/api/v1/conversations?limit=200")
    }

    func agentShares() async throws -> [String: [String]] {
        try await send("GET", "/api/v1/friends/agent-shares")
    }

    func conversation(_ conversationId: String) async throws -> RemoteConversation {
        try await send("GET", "/api/v1/conversations/\(escape(conversationId))")
    }

    func createConversation(members: [CreateConversationRequest.Member], name: String, autoTitle: Bool, permanent: Bool = false) async throws -> RemoteConversation {
        try await send("POST", "/api/v1/conversations", body: CreateConversationRequest(name: name, members: members, autoTitle: autoTitle, extra: ConversationExtra(permanent: permanent)))
    }

    /// Add people to a group chat (direct chats can't add people; the caller turns it into a group chat draft)
    func addMember(_ userId: String, to conversationId: String, role: String = "ENGINEER") async throws {
        let _: Empty? = try await sendOptional("POST", "/api/v1/conversations/\(escape(conversationId))/members",
                                               body: AddMemberRequest(userId: userId, role: role))
    }

    // MARK: Version

    /// Can check anonymously when logged out; when logged in the token is sent so the server can recognize per-account gray releases.
    func checkUpdate(currentVersion: String) async throws -> UpdateCheckResponse {
        try await send("POST", "/api/v1/app/updates/check", body: UpdateCheckRequest(
            channel: Self.updateChannel, arch: "arm64", currentVersion: currentVersion))
    }

    /// Debug builds run directly from Xcode check on the develop channel, same as the desktop dev build:
    /// when debugging against the production server, the release forced update won't block it (-dev versions are always lower than the same-numbered release).
    private static var updateChannel: String {
        #if DEBUG
        "develop"
        #else
        ServerEnvironment.current.rawValue
        #endif
    }

    // MARK: Block, report (real people only)

    func block(_ userId: String) async throws {
        let _: Empty? = try await sendOptional("POST", "/api/v1/friends/\(escape(userId))/block", body: Empty?.none)
    }

    func unblock(_ userId: String) async throws {
        let _: Empty? = try await sendOptional("DELETE", "/api/v1/friends/\(escape(userId))/block", body: Empty?.none)
    }

    func blocked() async throws -> [RemoteUser] {
        try await send("GET", "/api/v1/friends/blocked")
    }

    func report(_ userId: String, reason: ReportReason, detail: String, conversationId: String?) async throws {
        struct Body: Encodable { let reason: String; let detail: String; let conversationId: String? }
        let _: Empty? = try await sendOptional("POST", "/api/v1/friends/\(escape(userId))/report",
                                               body: Body(reason: reason.rawValue, detail: detail, conversationId: conversationId))
    }

    func setOwnerPaused(_ conversationId: String, paused: Bool) async throws {
        struct Body: Encodable { let paused: Bool }
        let _: Empty? = try await sendOptional("PUT", "/api/v1/conversations/\(escape(conversationId))/owner-pause", body: Body(paused: paused))
    }

    func agentActivity() async throws -> [AgentActivity] {
        try await send("GET", "/api/v1/agents/activity")
    }

    /// Ask the Agent's computer to run a real check; the return value only means it was dispatched.
    func requestAgentVerification(_ userId: String) async throws {
        let _: Bool = try await send("POST", "/api/v1/agents/\(escape(userId))/verify")
    }

    func messages(in conversationId: String, afterSeq: Int) async throws -> [RemoteMessage] {
        try await send("GET", "/api/v1/conversations/\(escape(conversationId))/messages?afterSeq=\(afterSeq)&limit=100")
    }

    func latestMessages(in conversationId: String) async throws -> [RemoteMessage] {
        try await send("GET", "/api/v1/conversations/\(escape(conversationId))/messages?limit=100")
    }

    func messages(in conversationId: String, beforeSeq: Int) async throws -> [RemoteMessage] {
        try await send("GET", "/api/v1/conversations/\(escape(conversationId))/messages?beforeSeq=\(beforeSeq)&limit=100")
    }

    /// With attachments, register and upload each to OSS first, then send the message once all are uploaded; on mid-way failure the whole message is resent, registration and upload are idempotent by attachment ID
    func sendMessage(_ content: String, to conversationId: String, messageId: String,
                     attachments: [LocalAttachment] = [], mentions: [String] = [],
                     replyTo: String? = nil, quote: MessageQuote? = nil) async throws -> RemoteMessage {
        for attachment in attachments {
            try await upload(attachment, to: conversationId)
        }
        let body = SendMessageRequest(messageId: messageId, content: content, mentions: mentions,
                                      replyTo: replyTo, extra: quote.map(SendMessageExtra.init),
                                      attachments: attachments.isEmpty ? nil : attachments.map(\.attachmentId))
        return try await send("POST", "/api/v1/conversations/\(escape(conversationId))/messages", body: body)
    }

    // MARK: Attachments

    /// Files go straight to OSS, not through the backend. Large videos take a while, so the timeout is relaxed
    private lazy var uploadSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 120
        configuration.timeoutIntervalForResource = 60 * 60
        return URLSession(configuration: configuration)
    }()

    private func upload(_ attachment: LocalAttachment, to conversationId: String) async throws {
        let request = CreateAttachmentRequest(attachmentId: attachment.attachmentId, name: attachment.name,
                                              mimeType: attachment.mimeType, size: attachment.size)
        let ticket: AttachmentTicket = try await send("POST", "/api/v1/conversations/\(escape(conversationId))/attachments", body: request)
        if ticket.uploaded { return }
        guard let url = URL(string: ticket.uploadUrl) else {
            throw APIError.rejected(code: "BAD_UPLOAD_URL", message: L10n.string("error.emptyResponse"))
        }
        var put = URLRequest(url: url)
        put.httpMethod = "PUT"
        put.setValue(ticket.contentType, forHTTPHeaderField: "Content-Type")
        let response: URLResponse
        do {
            (_, response) = try await uploadSession.upload(for: put, fromFile: attachment.fileURL)
        } catch {
            try RequestCancellation.check(error)
            throw APIError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw APIError.rejected(code: "UPLOAD_\(status)", message: L10n.format("attachment.uploadFailed %@", attachment.name))
        }
    }

    /// Download URLs expire after one hour: a fetched one is reused until 5 minutes before expiry
    private var downloadURLs: [String: (url: URL, expires: Date)] = [:]

    func attachmentURL(_ attachment: RemoteAttachment, in conversationId: String) async throws -> URL {
        if let cached = downloadURLs[attachment.attachmentId], cached.expires.timeIntervalSinceNow > 5 * 60 {
            return cached.url
        }
        let result: AttachmentURL = try await send("GET", "/api/v1/conversations/\(escape(conversationId))/attachments/\(escape(attachment.attachmentId))/url")
        guard let url = URL(string: result.url) else {
            throw APIError.rejected(code: "BAD_DOWNLOAD_URL", message: L10n.string("error.emptyResponse"))
        }
        downloadURLs[attachment.attachmentId] = (url, result.expiresAt ?? Date().addingTimeInterval(30 * 60))
        return url
    }

    /// Download to the cache directory before opening (preview and share both need a local file). Reuse previous downloads; the system may purge the cache when space is low, then download again
    func downloadedFile(_ attachment: RemoteAttachment, in conversationId: String) async throws -> URL {
        let target = LocalAttachment.cacheURL(for: attachment)
        if FileManager.default.fileExists(atPath: target.path) { return target }
        let url = try await attachmentURL(attachment, in: conversationId)
        let temporary: URL
        let response: URLResponse
        do {
            (temporary, response) = try await uploadSession.download(from: url)
        } catch {
            try RequestCancellation.check(error)
            throw APIError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            throw APIError.rejected(code: "DOWNLOAD_\(status)", message: L10n.format("attachment.downloadFailed %@", attachment.name))
        }
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? FileManager.default.removeItem(at: target)
        try FileManager.default.moveItem(at: temporary, to: target)
        return target
    }

    func markRead(_ conversationId: String, seq: Int) async throws {
        let _: Empty? = try await sendOptional("PUT", "/api/v1/conversations/\(escape(conversationId))/messages/read", body: SeqRequest(seq: seq))
    }

    // MARK: Requests

    private func send<T: Decodable>(_ method: String, _ path: String, authorized: Bool = true) async throws -> T {
        try await send(method, path, body: Empty?.none, authorized: authorized)
    }

    private func send<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?, authorized: Bool = true) async throws -> T {
        guard let value: T = try await sendOptional(method, path, body: body, authorized: authorized) else {
            throw APIError.rejected(code: "EMPTY", message: L10n.string("error.emptyResponse"))
        }
        return value
    }

    private func sendOptional<T: Decodable, B: Encodable>(_ method: String, _ path: String, body: B?, authorized: Bool = true, retried: Bool = false) async throws -> T? {
        let diagnosticScope = FeedbackDiagnostics.Scope(owner: Credentials.user?.userId, environment: ServerEnvironment.current.rawValue)
        let diagnosticRoute = path.split(separator: "?").first?.split(separator: "/").prefix(3).joined(separator: "/") ?? "api"
        // Contacts, conversations and messages are dynamic data. Always fetch from the server on refresh so URL caching doesn't keep showing old names after a computer is renamed.
        var request = URLRequest(url: URL(string: baseURL.absoluteString + path)!,
                                 cachePolicy: method == "GET" ? .reloadIgnoringLocalCacheData : .useProtocolCachePolicy)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        if authorized, let token = Credentials.accessToken {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            try RequestCancellation.check(error)
            let failure = error as NSError
            Task { await FeedbackDiagnostics.shared.record("http-network-error", fields: ["method": method, "route": diagnosticRoute, "domain": failure.domain, "code": String(failure.code)], scope: diagnosticScope) }
            throw APIError.network(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status >= 400 {
            Task { await FeedbackDiagnostics.shared.record("http-error", fields: ["method": method, "route": diagnosticRoute, "status": String(status)], scope: diagnosticScope) }
        }
        if status == 401 && authorized {
            try Task.checkCancellation()
            if !retried, try await refreshTokens() {
                try Task.checkCancellation()
                return try await sendOptional(method, path, body: body, authorized: authorized, retried: true)
            }
            try Task.checkCancellation()
            Credentials.clear()
            onUnauthorized?()
            throw APIError.unauthorized
        }
        let envelope: APIEnvelope<T>
        do {
            envelope = try decoder.decode(APIEnvelope<T>.self, from: data)
        } catch {
            throw APIError.rejected(code: "HTTP_\(status)", message: L10n.format("error.badResponse %lld", status))
        }
        // Online service isn't offered in mainland China: even logged-in users go back to the login page, which explains why
        if envelope.code == "REGION_001" && authorized {
            Credentials.clear()
            onUnauthorized?()
        }
        guard envelope.code == "OK" else {
            Task { await FeedbackDiagnostics.shared.record("api-error", fields: ["method": method, "route": diagnosticRoute, "code": envelope.code], scope: diagnosticScope) }
            throw APIError.rejected(code: envelope.code, message: envelope.message ?? envelope.code)
        }
        return envelope.data
    }

    /// Only one refresh at a time; concurrent requests all wait for that result
    private func refreshTokens() async throws -> Bool {
        if let refreshing { return try await refreshing.value }
        let conversation = Task<Bool, Error> {
            guard let refreshToken = Credentials.refreshToken else { return false }
            struct Body: Encodable { let refreshToken: String }
            do {
                let tokens: TokenResponse = try await send("POST", "/api/v1/auth/refresh", body: Body(refreshToken: refreshToken), authorized: false)
                Credentials.save(tokens)
                return true
            } catch {
                try RequestCancellation.check(error)
                return false
            }
        }
        refreshing = conversation
        defer { refreshing = nil }
        return try await conversation.value
    }

    private func escape(_ value: String) -> String {
        value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
    }
}

/// Login state: tokens in the keychain, current user profile in UserDefaults. Both live where the App and share extension share them (SharedStore).
enum Credentials {
    static var accessToken: String? { Keychain.read("accessToken") }
    static var refreshToken: String? { Keychain.read("refreshToken") }

    static var user: StoredUser? {
        guard let data = SharedStore.migrated("currentUser") else { return nil }
        return try? JSONDecoder().decode(StoredUser.self, from: data)
    }

    static func save(_ tokens: TokenResponse) {
        Keychain.write(tokens.accessToken, for: "accessToken")
        Keychain.write(tokens.refreshToken, for: "refreshToken")
        let user = StoredUser(userId: tokens.user.userId, username: tokens.user.username ?? "", displayName: tokens.user.displayName)
        SharedStore.defaults.set(try? JSONEncoder().encode(user), forKey: "currentUser")
    }

    static func clear() {
        Keychain.write(nil, for: "accessToken")
        Keychain.write(nil, for: "refreshToken")
        SharedStore.defaults.removeObject(forKey: "currentUser")
        UserDefaults.standard.removeObject(forKey: "currentUser")
    }

    /// Older versions kept tokens in the App's own keychain group, unreadable by the share extension: rewrite them on launch to move them into the shared group
    static func shareWithExtensions() {
        if let access = accessToken { Keychain.write(access, for: "accessToken") }
        if let refresh = refreshToken { Keychain.write(refresh, for: "refreshToken") }
        _ = user
    }
}

struct StoredUser: Codable, Equatable {
    let userId: String
    let username: String
    let displayName: String
}
