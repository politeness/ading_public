import Foundation

enum MessageMathContent {
    static func containsFormula(_ content: String) -> Bool {
        // Exclude fenced and inline code before considering formula delimiters.
        let code = #"(?ms)^ {0,3}(`{3,}|~{3,})[^\n]*\n.*?^ {0,3}\1[ \t]*(?:$|\n)|`+[^`]*`+"#
        let plain = content.replacingOccurrences(of: code, with: "", options: .regularExpression)
        let math = #"(?s)(?<!\\)\\\[.+?\\\]|(?<!\\)\\\([^\n]+?\\\)|(?<!\\)\$\$.+?\$\$|(?<![\\$])\$(?!\s)[^$\n]+?(?<!\s)\$(?!\d)"#
        return plain.range(of: math, options: .regularExpression) != nil
    }
}
