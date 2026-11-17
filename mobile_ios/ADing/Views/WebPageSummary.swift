import Foundation

/// Only public page metadata, rendered as plain text; never execute or display HTML.
struct WebPageSummary: Sendable, Codable {
    var title = ""
    var description = ""
    var siteName = ""

    static func parse(_ html: String) -> WebPageSummary {
        var meta: [String: String] = [:]
        for tag in matches(#"<meta\b(?:[^"'<>]|"[^"]*"|'[^']*')*>"#, in: html) {
            var attributes: [String: String] = [:]
            for match in matches(#"([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#, in: tag[0]) {
                attributes[match[1].lowercased()] = match.dropFirst(2).first(where: { !$0.isEmpty }) ?? ""
            }
            if let key = attributes["property"] ?? attributes["name"],
               let content = attributes["content"] { meta[key.lowercased()] = content }
        }
        let title = meta["og:title"] ?? meta["twitter:title"]
            ?? matches(#"<title\b[^>]*>(.*?)</title>"#, in: html).first?[1] ?? ""
        let description = meta["og:description"] ?? meta["description"] ?? meta["twitter:description"] ?? ""
        return WebPageSummary(title: String(plain(title).prefix(240)),
                              description: String(plain(description).prefix(700)),
                              siteName: String(plain(meta["og:site_name"] ?? "").prefix(120)))
    }

    private static func matches(_ pattern: String, in text: String) -> [[String]] {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).map { match in
            (0..<match.numberOfRanges).map { index in
                Range(match.range(at: index), in: text).map { String(text[$0]) } ?? ""
            }
        }
    }

    private static func plain(_ value: String) -> String {
        var text = value.replacingOccurrences(of: #"<[^>]*>"#, with: "", options: .regularExpression)
        let named = ["amp": "&", "quot": "\"", "apos": "'", "lt": "<", "gt": ">", "nbsp": " "]
        let regex = try! NSRegularExpression(pattern: #"&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);"#, options: .caseInsensitive)
        // Work backwards over original ranges so each entity is decoded exactly once.
        for entity in regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).reversed() {
            guard let keyRange = Range(entity.range(at: 1), in: text),
                  let range = Range(entity.range, in: text) else { continue }
            let key = String(text[keyRange]).lowercased()
            let decoded: String?
            if key.hasPrefix("#") {
                let hex = key.hasPrefix("#x")
                let digits = String(key.dropFirst(hex ? 2 : 1))
                decoded = UInt32(digits, radix: hex ? 16 : 10).flatMap(UnicodeScalar.init).map(String.init)
            } else { decoded = named[key] }
            if let decoded { text.replaceSubrange(range, with: decoded) }
        }
        return text.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
