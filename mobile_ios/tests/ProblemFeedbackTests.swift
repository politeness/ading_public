import Foundation

actor FeedbackTransportFixture {
    var status = 200
    var code = "OK"
    var replyStatus = "uploaded"
    var offline = false
    var malformed = false
    var wrongId = false
    var requests: [URLRequest] = []
    func configure(status: Int = 200, code: String = "OK", replyStatus: String = "uploaded", offline: Bool = false, malformed: Bool = false, wrongId: Bool = false) {
        self.status = status; self.code = code; self.replyStatus = replyStatus
        self.offline = offline; self.malformed = malformed; self.wrongId = wrongId
    }
    func send(_ request: URLRequest) async throws -> (Data, URLResponse) {
        requests.append(request)
        try await Task.sleep(for: .milliseconds(15))
        if offline { throw URLError(.notConnectedToInternet) }
        guard let bytes = request.httpBody, let body = try JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let reportId = body["reportId"] as? String else { throw ProblemFeedback.Failure.response }
        let id = wrongId ? "wrong-id" : reportId
        let data = malformed ? Data("not-json".utf8) : try JSONSerialization.data(withJSONObject: ["code": code, "message": "fixture rejection", "data": ["reportId": id, "status": replyStatus]])
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil) else { throw ProblemFeedback.Failure.response }
        return (data, response)
    }
    func count() -> Int { requests.count }
    func last() -> URLRequest? { requests.last }
}

@main struct ProblemFeedbackTests {
    static var failures = 0
    static var checks = 0
    static func check(_ condition: Bool, _ message: String, line: Int = #line) {
        checks += 1
        if !condition { failures += 1; FileHandle.standardError.write(Data("FAIL \(line): \(message)\n".utf8)) }
    }
    static func report(description: String = "This is a problem", images: [FeedbackImage] = [], screenshot: FeedbackImage? = nil) -> ProblemFeedback {
        let now = ISO8601DateFormatter().string(from: Date())
        return ProblemFeedback(reportId: "report_" + UUID().uuidString, createdAt: now, occurredAt: now, description: description,
            screenshot: screenshot, images: images, context: .init(appVersion: "0.11.0", platform: "ios", arch: "arm64", mode: "remote", logs: [.init(name: "ios-last-48h.log", content: "{\"event\":\"app-start\"}")], userId: "u_fixture", terminalId: "mobile_fixture"))
    }
    static func main() async {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("ading-feedback-test-" + UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            let fixture = FeedbackTransportFixture()
            let queue = ProblemFeedbackQueue(directory: root, transport: { try await fixture.send($0) })
            let base = URL(string: "https://feedback.invalid/pre")!
            let image = FeedbackImage(name: "screen.jpg", jpeg: Data([255, 216, 255, 217]))
            let payload = report(images: [image], screenshot: image)
            try payload.validate()
            guard let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(payload)) as? [String: Any] else { throw ProblemFeedback.Failure.response }
            check(json["schemaVersion"] as? Int == 3, "same desktop schema")
            check((json["context"] as? [String: Any])?["platform"] as? String == "ios", "mobile platform survives serialization")
            do { try report(description: "    ").validate(); check(false, "reject blank description") } catch { check(true, "reject blank description") }
            do { try report(description: String(repeating: "😀", count: 2001)).validate(); check(false, "UTF16 length matches Java") } catch { check(true, "UTF16 length matches Java") }
            do { try report(images: Array(repeating: image, count: 6)).validate(); check(false, "reject too many images") } catch { check(true, "reject too many images") }
            do { try report(images: [FeedbackImage(name: "large.jpg", jpeg: Data(count: 5 * 1024 * 1024 + 1))]).validate(); check(false, "single image limit") } catch { check(true, "single image limit") }
            let fourMB = FeedbackImage(name: "four.jpg", jpeg: Data(count: 4 * 1024 * 1024))
            do { try report(images: [fourMB, fourMB, fourMB], screenshot: fourMB).validate(); check(false, "total includes screenshot") } catch { check(true, "total includes screenshot") }
            try await queue.enqueue(payload, baseURL: base)
            let file = root.appendingPathComponent("pending").appendingPathComponent(payload.reportId + ".json")
            check(FileManager.default.fileExists(atPath: file.path), "persist before trying network")
            guard let saved = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                  let storedPayload = saved["payload"], let storedEndpoint = saved["endpoint"] else { throw ProblemFeedback.Failure.response }
            _ = try JSONDecoder().decode(ProblemFeedback.self, from: JSONSerialization.data(withJSONObject: storedPayload))
            _ = try JSONDecoder().decode(URL.self, from: JSONSerialization.data(withJSONObject: storedEndpoint, options: [.fragmentsAllowed]))
            check(await queue.upload(payload.reportId) == .submitted, "valid receipt confirms delivery")
            check(!FileManager.default.fileExists(atPath: file.path), "remove delivered content")
            guard let request = await fixture.last() else { throw ProblemFeedback.Failure.response }
            check(request.url?.absoluteString == "https://feedback.invalid/pre/api/v1/support/reports", "same desktop route and captured environment")
            check(request.httpMethod == "POST" && request.value(forHTTPHeaderField: "Authorization") == nil, "public reports also work before login")

            // New reports use manual images only. Old pending drafts above still
            // retain their optional screenshot when retried after an upgrade.
            let manualOnly = report(images: [image])
            try await queue.enqueue(manualOnly, baseURL: base)
            check(await queue.upload(manualOnly.reportId) == .submitted, "manual-only feedback is accepted without a screenshot")
            guard let manualRequest = await fixture.last(), let manualBytes = manualRequest.httpBody,
                  let manualBody = try JSONSerialization.jsonObject(with: manualBytes) as? [String: Any] else { throw ProblemFeedback.Failure.response }
            check(manualBody["screenshot"] == nil, "no automatic screenshot field in a new report")
            check((manualBody["images"] as? [[String: Any]])?.count == 1, "manual attachment survives upload")
            check(((manualBody["context"] as? [String: Any])?["logs"] as? [[String: Any]])?.first?["name"] as? String == "ios-last-48h.log", "diagnostic logs remain attached without a screenshot")

            await fixture.configure(offline: true)
            let retry = report(); try await queue.enqueue(retry, baseURL: base)
            check(await queue.upload(retry.reportId) == .queued, "offline means queued, not submitted")
            await fixture.configure(replyStatus: "duplicate")
            let reopened = ProblemFeedbackQueue(directory: root, transport: { try await fixture.send($0) })
            await reopened.flush()
            check(!FileManager.default.fileExists(atPath: root.appendingPathComponent("pending/\(retry.reportId).json").path), "restart retries original report; duplicate receipt is success")
            check((await fixture.last())?.url?.absoluteString.contains("/pre/") == true, "restart does not switch backend")

            for config in [408, 429, 500] {
                await fixture.configure(status: config)
                let retryable = report(); try await queue.enqueue(retryable, baseURL: base)
                check(await queue.upload(retryable.reportId) == .queued, "HTTP \(config) is retryable")
            }
            for badReceipt in [0, 1] {
                await fixture.configure(malformed: badReceipt == 0, wrongId: badReceipt == 1)
                let bad = report(); try await queue.enqueue(bad, baseURL: base)
                check(await queue.upload(bad.reportId) == .queued, "no false success on malformed/wrong receipt")
            }
            for status in [400, 200] {
                await fixture.configure(status: status, code: "SUPPORT_BAD")
                let bad = report(); try await queue.enqueue(bad, baseURL: base)
                check(await queue.upload(bad.reportId) == .rejected(L10n.string("error.requestFailed")), "permanent rejection stays visible in the UI language, not the server text")
                check(FileManager.default.fileExists(atPath: root.appendingPathComponent("failed/\(bad.reportId).json").path), "retain rejected content for diagnosis")
            }
            await fixture.configure()
            let single = report(); try await queue.enqueue(single, baseURL: base)
            let before = await fixture.count()
            async let first = queue.upload(single.reportId)
            async let second = queue.upload(single.reportId)
            _ = await (first, second)
            check(await fixture.count() == before + 1, "foreground and submit do not upload the same report concurrently")
            await reopened.flush()
            check((try FileManager.default.contentsOfDirectory(atPath: root.appendingPathComponent("pending").path)).isEmpty, "temporary failures eventually drain")

            let diagnostics = FeedbackDiagnostics(directory: root.appendingPathComponent("logs"))
            let scope = FeedbackDiagnostics.Scope(owner: "u_a", environment: "pre")
            let now = Date()
            await diagnostics.record("old", scope: scope, now: now.addingTimeInterval(-49 * 3600))
            await diagnostics.record("http-error", fields: ["status": "503", "token": "private-token", "body": "private-message"], scope: scope, now: now)
            let log = await diagnostics.snapshot(scope, now: now)
            check(log.contains("http-error") && log.contains("503"), "attach useful diagnostic status")
            check(!log.contains("old") && !log.contains("private"), "48-hour window and no payload/credentials")
            check(await diagnostics.snapshot(.init(owner: "u_b", environment: "pre")) == "", "account isolation")
            check(await diagnostics.snapshot(.init(owner: "u_a", environment: "release")) == "", "server isolation")
            check(await diagnostics.snapshot(.init(owner: nil, environment: "pre")) == "", "anonymous logs do not include prior users")
        } catch { check(false, "unexpected error: \(error)") }
        try? FileManager.default.removeItem(at: root)
        print("problem-feedback: \(checks) checks, \(failures) failures")
        if failures > 0 { exit(1) }
    }
}
