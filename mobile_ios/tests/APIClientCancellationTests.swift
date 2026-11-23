import Foundation

// Test-only storage and diagnostics: never touch the app's credentials or log files.
enum Keychain {
    static var values: [String: String] = [:]
    static func read(_ key: String) -> String? { values[key] }
    static func write(_ value: String?, for key: String) { values[key] = value }
}
enum SharedStore {
    static let name = "ading-network-tests-" + UUID().uuidString
    static let defaults = UserDefaults(suiteName: name)!
    static func migrated(_ key: String) -> Data? { defaults.data(forKey: key) }
}
enum ServerEnvironment: String {
    case test
    static var current: Self { .test }
    var baseURL: URL { URL(string: "https://api.example.invalid")! }
}
enum L10n {
    static func string(_ key: String) -> String { key }
    static func format(_ key: String, _ args: CVarArg...) -> String { key }
    static func optional(_ key: String) -> String? { key == "server.error.AUTH_002" ? key : nil }
}
actor FeedbackDiagnostics {
    struct Scope { let owner: String?; let environment: String }
    static let shared = FeedbackDiagnostics()
    func record(_ event: String, fields: [String: String], scope: Scope) {}
}

final class StubProtocol: URLProtocol {
    enum Reply { case error(URLError.Code), response(Int, String), wait }
    static let lock = NSLock()
    static var replies: [Reply] = []
    static var onStart: (() -> Void)?
    static func prepare(_ replies: [Reply], onStart: (() -> Void)? = nil) {
        lock.lock(); defer { lock.unlock() }
        self.replies = replies
        self.onStart = onStart
    }
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.lock.lock()
        let reply = Self.replies.removeFirst()
        let onStart = Self.onStart
        Self.lock.unlock()
        onStart?()
        switch reply {
        case .error(let code): client?.urlProtocol(self, didFailWithError: URLError(code))
        case .response(let status, let body):
            client?.urlProtocol(self, didReceive: HTTPURLResponse(url: request.url!, statusCode: status,
                                                                 httpVersion: nil, headerFields: nil)!, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: Data(body.utf8))
            client?.urlProtocolDidFinishLoading(self)
        case .wait: break // URLSession cancellation must call stopLoading and unblock its caller.
        }
    }
    override func stopLoading() {}
}

@main struct APIClientCancellationTests {
    static func main() async throws {
        // Server text is English only: known codes use local text, unknown codes a generic one, client-made errors keep theirs
        precondition(APIError.rejected(code: "AUTH_002", message: "Incorrect username or password").errorDescription == "server.error.AUTH_002")
        precondition(APIError.rejected(code: "AUTH_999", message: "Something new").errorDescription == "error.requestFailed")
        precondition(APIError.rejected(code: "HTTP_502", message: "local text").errorDescription == "local text")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: config)
        let api = APIClient(session: session)
        let standardUser = UserDefaults.standard.object(forKey: "currentUser")
        defer {
            session.invalidateAndCancel()
            SharedStore.defaults.removePersistentDomain(forName: SharedStore.name)
            UserDefaults.standard.set(standardUser, forKey: "currentUser")
            Keychain.values.removeAll()
        }
        StubProtocol.prepare([.error(.cancelled)])
        do { _ = try await api.conversations(); fatalError("Expected cancellation") }
        catch { precondition(error is CancellationError, "REST must retain typed cancellation") }

        let started = AsyncStream<Void> { continuation in
            StubProtocol.prepare([.wait], onStart: { continuation.yield(()); continuation.finish() })
        }
        let pending = Task { try await api.conversations() }
        for await _ in started { pending.cancel() }
        do { _ = try await pending.value; fatalError("Expected task cancellation") }
        catch { precondition(error is CancellationError, "Cancelling a live URLSession task stays silent") }

        StubProtocol.prepare([.error(.timedOut)])
        do { _ = try await api.conversations(); fatalError("Expected network failure") }
        catch APIError.network { /* Real failures still reach the UI. */ }

        StubProtocol.prepare([.response(200, #"{"code":"OK","data":[]}"#)])
        let recovered = try await api.conversations()
        precondition(recovered.isEmpty, "A cancelled request must not poison later requests")

        Keychain.values = ["accessToken": "test-access", "refreshToken": "test-refresh"]
        StubProtocol.prepare([.response(401, "{}"), .error(.cancelled)])
        do { _ = try await api.conversations(); fatalError("Expected refresh cancellation") }
        catch { precondition(error is CancellationError, "Cancelled token refresh must not become unauthorized") }
        precondition(Keychain.read("accessToken") == "test-access", "Cancelled refresh must not sign out")

        StubProtocol.prepare([.response(401, "{}"), .response(401, #"{"code":"AUTH_EXPIRED","message":"Expired"}"#)])
        do { _ = try await api.conversations(); fatalError("Expected authentication failure") }
        catch APIError.unauthorized { /* Actual authentication rejection still signs out. */ }
        precondition(Keychain.read("accessToken") == nil, "Actual auth rejection clears credentials")
        print("APIClientCancellationTests: REST/task cancellation, timeout, recovery, refresh cancellation and auth rejection passed")
    }
}
