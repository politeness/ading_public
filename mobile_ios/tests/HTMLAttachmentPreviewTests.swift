// macOS-only WebKit integration test; iOS touch gestures still need device validation.
import AppKit
import WebKit

@main
struct HTMLAttachmentPreviewTests {
    enum Failure: Error { case check(String) }

    static func check(_ value: Bool, _ message: String = "Check failed") throws {
        if !value { throw Failure.check(message) }
    }

    @MainActor
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        Task { @MainActor in
            do {
                try await run()
                print("HTMLAttachmentPreview: routing, external navigation, JavaScript, canvas animation, pointer handler, file isolation and cleanup passed")
                exit(0)
            } catch {
                fputs("HTMLAttachmentPreview failed: \(error)\n", stderr)
                exit(1)
            }
        }
        app.run()
    }

    @MainActor
    static func run() async throws {
        for name in ["index.html", "animation.HTM", "测试.HTML"] {
            try check(HTMLAttachment.matches(name: name))
        }
        for name in ["index.html.txt", "photo.png", "document.pdf", "notes.txt"] {
            try check(!HTMLAttachment.matches(name: name))
        }

        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let file = directory.appendingPathComponent("index.html")
        let sibling = directory.appendingPathComponent("private.txt")
        try "outside-the-attachment".write(to: sibling, atomically: true, encoding: .utf8)
        try """
        <!doctype html><meta name="viewport" content="width=device-width, initial-scale=1">
        <canvas id="canvas" width="200" height="100"></canvas><button id="move">Move</button>
        <a id="link" href="https://example.com/tapped">Link</a>
        <script>
        setTimeout(() => { location.href = 'https://example.com/redirect'; }, 0);
        window.framesRun = 0; window.moves = 0;
        const ctx = canvas.getContext('2d');
        function animate() {
          window.framesRun++; ctx.fillStyle = 'red'; ctx.fillRect(0, 0, 10, 10);
          requestAnimationFrame(animate);
        }
        requestAnimationFrame(animate);
        move.addEventListener('pointerdown', () => window.moves++);
        window.siblingRead = 'pending';
        const request = new XMLHttpRequest(); request.open('GET', 'private.txt');
        request.onload = () => window.siblingRead = request.responseText.includes('outside-the-attachment') ? 'leaked' : 'blocked';
        request.onerror = () => window.siblingRead = 'blocked'; request.send();
        </script>
        """.write(to: file, atomically: true, encoding: .utf8)

        let browser = HTMLAttachmentBrowser(fileURL: file)
        var failed = false
        browser.onFailure = { failed = true }
        var opened: [URL] = []
        browser.openExternally = { opened.append($0) }
        func decide(_ url: URL?, main: Bool = true, link: Bool = false) -> HTMLAttachmentBrowser.NavigationDecision {
            browser.decision(for: url, mainFrame: main, linkActivated: link)
        }
        try check(decide(URL(string: file.absoluteString + "#section")!) == .allow, "attachment itself loads")
        try check(decide(URL(string: file.absoluteString + "#section")!, link: true) == .allow, "in-page anchors stay")
        try check(decide(sibling) == .cancel && decide(sibling, main: false) == .cancel, "sibling file blocked")
        try check(decide(directory.appendingPathComponent("nested/../private.txt")) == .cancel, "path traversal blocked")
        try check(decide(URL(string: "ading://test")!, link: true) == .cancel, "custom scheme blocked")
        try check(decide(nil) == .cancel, "missing URL blocked")
        let external = URL(string: "https://example.com/login")!
        try check(decide(external) == .cancel, "scripted top-level redirect blocked")
        try check(decide(URL(string: "http://example.com")!) == .cancel, "plain http redirect blocked")
        try check(decide(external, link: true) == .openExternally, "tapped link goes to the system browser")
        try check(decide(external, main: false) == .allow, "subframes keep loading")
        try check(decide(URL(string: "about:blank")!) == .allow && decide(URL(string: "data:text/plain,x")!, main: false) == .allow)
        let view = browser.makeWebView()
        try check(!view.configuration.websiteDataStore.isPersistent)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 390, height: 700),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = view
        window.orderBack(nil)
        defer {
            view.stopLoading()
            view.navigationDelegate = nil
            window.orderOut(nil)
        }

        let deadline = Date().addingTimeInterval(25)
        var ready = false
        while Date() < deadline {
            if let result = try? await view.evaluateJavaScript("window.framesRun > 2 && window.siblingRead === 'blocked'"),
               result as? Bool == true { ready = true; break }
            try await Task.sleep(nanoseconds: 200_000_000)
        }
        if !ready || failed {
            let state = try? await view.evaluateJavaScript("JSON.stringify({frames:window.framesRun, sibling:window.siblingRead, state:document.readyState})")
            print("WebKit state: \(state ?? "unavailable"); failed=\(failed)")
            fflush(stdout)
        }
        try check(ready && !failed, "Animation did not run, page failed, or sibling file was readable")
        let result = try await view.evaluateJavaScript("""
        move.dispatchEvent(new PointerEvent('pointerdown', {pointerType:'touch', bubbles:true}));
        window.moves === 1 && canvas.getContext('2d').getImageData(0,0,1,1).data[0] === 255;
        """)
        try check(result as? Bool == true)
        try check(view.url?.standardizedFileURL.path == file.standardizedFileURL.path, "scripted redirect left the attachment")
        try check(opened.isEmpty, "scripted redirect opened the system browser")
        let tapped = try await view.evaluateJavaScript("link.click(); window.framesRun > 0")
        try await Task.sleep(nanoseconds: 500_000_000)
        try check(tapped as? Bool == true, "page unloaded after link click")
        try check(view.url?.standardizedFileURL.path == file.standardizedFileURL.path, "link replaced the preview")
        print("HTMLAttachmentPreview: scripted link click opened externally: \(opened.map(\.absoluteString))")
    }
}
