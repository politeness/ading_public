import SwiftUI
import WebKit

/// Only messages containing equations use the local, network-free math document.
struct MessageMathView: View {
    let content: String
    let mine: Bool
    let mentions: [MentionHighlight]
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var height: CGFloat = 24
    @State private var failed = false

    var body: some View {
        if failed {
            Text(verbatim: content).fixedSize(horizontal: false, vertical: true)
        } else {
            MathWebContent(content: content, mine: mine, mentions: mentions,
                           dark: colorScheme == .dark, typeSize: dynamicTypeSize,
                           height: $height, failed: $failed)
                .frame(maxWidth: .infinity)
                .frame(height: height)
        }
    }
}

private struct MathWebContent: UIViewRepresentable {
    let content: String
    let mine: Bool
    let mentions: [MentionHighlight]
    let dark: Bool
    let typeSize: DynamicTypeSize
    @Binding var height: CGFloat
    @Binding var failed: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(context.coordinator, name: "mathHeight")
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = context.coordinator
        view.allowsLinkPreview = false
        view.isOpaque = false
        view.backgroundColor = .clear
        view.scrollView.backgroundColor = .clear
        view.scrollView.isScrollEnabled = false
        view.scrollView.contentInsetAdjustmentBehavior = .never
        guard let file = Bundle.main.url(forResource: "math", withExtension: "html", subdirectory: "math") else {
            DispatchQueue.main.async { failed = true }; return view
        }
        view.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        return view
    }
    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.update(view)
    }
    static func dismantleUIView(_ view: WKWebView, coordinator: Coordinator) {
        view.configuration.userContentController.removeScriptMessageHandler(forName: "mathHeight")
        view.navigationDelegate = nil
        view.stopLoading()
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: MathWebContent
        var ready = false
        var revision = 0
        var previous: String?
        init(_ parent: MathWebContent) { self.parent = parent }
        func update(_ view: WKWebView) {
            guard ready else { return }
            let traits = UITraitCollection(userInterfaceStyle: parent.dark ? .dark : .light)
            func hex(_ color: UIColor) -> String {
                var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
                color.resolvedColor(with: traits).getRed(&r, green: &g, blue: &b, alpha: &a)
                return String(format: "#%02x%02x%02x", Int(r * 255), Int(g * 255), Int(b * 255))
            }
            let style: [String: Any] = ["foreground": hex(parent.mine ? .white : .label),
                "link": hex(parent.mine ? .white : .link), "mentionSelf": hex(parent.mine ? .white : .systemRed),
                "size": UIFont.preferredFont(forTextStyle: .body).pointSize,
                "language": Locale.current.language.languageCode?.identifier ?? "en"]
            let mentions = parent.mentions.map { ["label": $0.label, "mine": $0.mine] as [String: Any] }
            let key: [String: Any] = ["content": parent.content, "style": style, "mentions": mentions, "typeSize": String(describing: parent.typeSize)]
            let identity = String(data: (try? JSONSerialization.data(withJSONObject: key, options: .sortedKeys)) ?? Data(), encoding: .utf8) ?? ""
            guard identity != previous else { return }
            previous = identity; revision += 1
            view.callAsyncJavaScript("window.updateMessage(content, mentions, style, revision)",
                                     arguments: ["content": parent.content, "mentions": mentions, "style": style, "revision": revision],
                                     in: nil, in: .page) { [weak self] result in
                if case .failure = result { self?.parent.failed = true }
            }
        }
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { ready = true; update(webView) }
        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { parent.failed = true }
        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { parent.failed = true }
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { parent.failed = true }
        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let data = message.body as? [String: Any], let value = data["height"] as? Double,
                  let receivedRevision = data["revision"] as? Int, receivedRevision == revision,
                  value.isFinite, value > 0, value < 10_000_000 else { return }
            let next = CGFloat(ceil(value))
            if abs(parent.height - next) > 0.5 { parent.height = next }
        }
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated {
                if let url = navigationAction.request.url, ["https", "http"].contains(url.scheme?.lowercased() ?? "") {
                    UIApplication.shared.open(url)
                }
                decisionHandler(.cancel)
            } else {
                decisionHandler(navigationAction.request.url?.isFileURL == true ? .allow : .cancel)
            }
        }
    }
}
