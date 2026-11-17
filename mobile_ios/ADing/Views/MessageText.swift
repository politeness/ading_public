import Foundation

/// Keep Markdown link labels and line breaks, and make bare web URLs tappable as well.
enum MessageText {
    static func attributed(_ content: String) -> AttributedString {
        var text = (try? AttributedString(markdown: content,
                                          options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(content)
        let plain = String(text.characters)
        if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            for match in detector.matches(in: plain, range: NSRange(plain.startIndex..., in: plain)) {
                guard let url = match.url, isWebURL(url),
                      let stringRange = Range(match.range, in: plain),
                      let lower = AttributedString.Index(stringRange.lowerBound, within: text),
                      let upper = AttributedString.Index(stringRange.upperBound, within: text) else { continue }
                // An explicit Markdown label may itself contain a URL. Keep its authored target.
                if text[lower..<upper].runs.allSatisfy({ $0.link == nil }) {
                    text[lower..<upper].link = url
                }
            }
        }
        return text
    }

    static func webURLs(in text: AttributedString) -> [URL] {
        var seen = Set<URL>()
        return text.runs.compactMap { run in
            guard let url = run.link, isWebURL(url), seen.insert(url).inserted else { return nil }
            return url
        }
    }

    /// A bare URL is already represented by its card. Keep authored labels and all other text.
    static func previewBody(_ text: AttributedString) -> AttributedString {
        var result = AttributedString()
        for run in text.runs {
            let part = text[run.range]
            if let url = run.link, isWebURL(url),
               String(part.characters) == url.absoluteString { continue }
            result.append(AttributedString(part))
        }
        return result
    }

    private static func isWebURL(_ url: URL) -> Bool {
        ["http", "https"].contains(url.scheme?.lowercased() ?? "") && url.host != nil
    }
}
