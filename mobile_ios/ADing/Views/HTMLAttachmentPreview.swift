import SwiftUI
import WebKit

struct HTMLAttachment: Identifiable {
    let id = UUID()
    let url: URL
    let name: String

    static func matches(name: String) -> Bool {
        let ext = (name as NSString).pathExtension.lowercased()
        return ext == "html" || ext == "htm"
    }
}

/// A separate, ephemeral web context: no app cookies, credentials or native bridge.
@MainActor
final class HTMLAttachmentBrowser: NSObject, WKNavigationDelegate {
    let fileURL: URL
    var onFailure: (() -> Void)?

    init(fileURL: URL) {
        self.fileURL = fileURL.standardizedFileURL
    }

    func makeWebView() -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        #if os(iOS)
        configuration.allowsInlineMediaPlayback = true
        #endif
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.navigationDelegate = self
        view.allowsBackForwardNavigationGestures = true
        // Grant access to this file only, never the attachment cache or app container.
        view.loadFileURL(fileURL, allowingReadAccessTo: fileURL)
        return view
    }

    enum NavigationDecision: Equatable { case allow, cancel, openExternally }

    /// Opens a link the user tapped outside the preview (Safari), so external pages are never shown
    /// under the attachment's title.
    var openExternally: (URL) -> Void = { url in
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    /// `mainFrame` is false only for subframe loads; new-window requests (no target frame) count as top-level.
    func decision(for url: URL?, mainFrame: Bool, linkActivated: Bool) -> NavigationDecision {
        guard let url else { return .cancel }
        if url.isFileURL {
            return url.standardizedFileURL.path == fileURL.path ? .allow : .cancel
        }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" {
            if !mainFrame { return .allow }
            // Script-driven redirects are dropped; user taps leave the app for the system browser.
            return linkActivated ? .openExternally : .cancel
        }
        return ["about", "data", "blob"].contains(scheme) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        switch decision(for: url, mainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
                        linkActivated: navigationAction.navigationType == .linkActivated) {
        case .allow: decisionHandler(.allow)
        case .cancel: decisionHandler(.cancel)
        case .openExternally:
            decisionHandler(.cancel)
            if let url { openExternally(url) }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onFailure?() }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { onFailure?() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { onFailure?() }
}

#if os(iOS)
struct HTMLAttachmentScreen: View {
    let attachment: HTMLAttachment
    @Environment(\.dismiss) private var dismiss
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Group {
                if failed {
                    Text(L10n.format("attachment.unreadable %@", attachment.name))
                        .foregroundStyle(.secondary)
                } else {
                    HTMLAttachmentWebView(url: attachment.url, failed: $failed)
                }
            }
            .navigationTitle(attachment.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("attachment.preview.close") { dismiss() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    ShareLink(item: attachment.url)
                }
            }
        }
    }
}

private struct HTMLAttachmentWebView: UIViewRepresentable {
    let url: URL
    @Binding var failed: Bool

    func makeCoordinator() -> HTMLAttachmentBrowser { HTMLAttachmentBrowser(fileURL: url) }

    func makeUIView(context: Context) -> WKWebView {
        context.coordinator.onFailure = { failed = true }
        return context.coordinator.makeWebView()
    }

    func updateUIView(_ view: WKWebView, context: Context) {
        context.coordinator.onFailure = { failed = true }
    }

    static func dismantleUIView(_ view: WKWebView, coordinator: HTMLAttachmentBrowser) {
        coordinator.onFailure = nil
        view.stopLoading()
        view.navigationDelegate = nil
    }
}
#endif
