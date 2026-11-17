import Foundation

@main struct MessageTextTests {
    static func main() {
        func check(_ value: @autoclosure () -> Bool, _ name: String) {
            guard value() else { fatalError(name) }
        }
        let article = "https://mp.weixin.qq.com/s/wsVYZoKRKpuFDJgWEJODag"
        let bare = MessageText.attributed("看看这篇文章：\(article)\n下一行保留")
        check(MessageText.webURLs(in: bare).map(\.absoluteString) == [article], "bare article URL links")
        check(String(bare.characters).contains("\n下一行保留"), "multiline text preserved")
        let markdown = MessageText.attributed("请按[Example skill](https://example.com/skill)确认。")
        check(String(markdown.characters) == "请按Example skill确认。", "Markdown label preserved")
        check(MessageText.webURLs(in: markdown).map(\.absoluteString) == ["https://example.com/skill"], "Markdown target preserved")
        let repeated = MessageText.attributed("\(article)\n\(article)")
        check(MessageText.webURLs(in: repeated).count == 1, "one preview per unique URL")
        let custom = MessageText.attributed("[local](/Users/name/skill.md) [mail](mailto:test@example.com) [remote](https://example.com)")
        check(MessageText.webURLs(in: custom).map(\.absoluteString) == ["https://example.com"], "only web URLs create previews")
        let explicit = MessageText.attributed("[https://label.example](https://target.example)")
        check(MessageText.webURLs(in: explicit).map(\.absoluteString) == ["https://target.example"], "URL-like Markdown labels keep their target")
        let long = String(repeating: "完整消息不能截断，包含所有内容。\n", count: 100)
        check(String(MessageText.attributed(long).characters) == long, "long message is intact")
        check(String(MessageText.previewBody(MessageText.attributed(article)).characters).isEmpty, "URL-only message uses just its embedded card")
        let caption = MessageText.attributed("这是文章标题 \(article)")
        check(String(MessageText.previewBody(caption).characters) == "这是文章标题 ", "shared title is retained without repeating the long URL")
        check(String(caption.characters) == "这是文章标题 \(article)", "display compaction never rewrites the original message")
        check(String(MessageText.previewBody(markdown).characters) == "请按Example skill确认。", "authored Markdown labels are retained")
        print("MessageTextTests: 11 passed")
    }
}
