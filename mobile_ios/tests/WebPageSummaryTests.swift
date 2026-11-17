import Foundation

@main struct WebPageSummaryTests {
    static func main() {
        func check(_ value: @autoclosure () -> Bool, _ name: String) {
            guard value() else { fatalError(name) }
        }
        let page = WebPageSummary.parse("""
        <html><head><title>Fallback</title>
        <meta content="真实标题 &amp; 副标题" property="og:title">
        <meta NAME='description' CONTENT='原始摘要'>
        <meta property="og:description" content="第一行 &gt; 第二行 &#x4e2d;&#25991; &quot;引号&quot;">
        <meta property=og:site_name content=站点></head></html>
        """)
        check(page.title == "真实标题 & 副标题", "OpenGraph title and named entities")
        check(page.description == "第一行 > 第二行 中文 \"引号\"", "description precedence, numeric entities and quotes")
        check(page.siteName == "站点", "unquoted attributes")
        check(WebPageSummary.parse("<title>备用\n 标题</title>").title == "备用 标题", "title fallback and whitespace")
        check(WebPageSummary.parse("<meta name=description content='a > b'>").description == "a > b", "quoted angle brackets")
        check(WebPageSummary.parse("<meta name=description content='&lt; &amp;lt;'>").description == "< &lt;", "entities decode once")
        check(WebPageSummary.parse("<html>body without public summary</html>").description.isEmpty, "missing summary is not invented")
        check(WebPageSummary.parse("<meta name=description content='<b>plain</b> text'>").description == "plain text", "HTML stays plain text")
        check(WebPageSummary.parse("<meta name=description content='\(String(repeating: "a", count: 900))'>").description.count == 700, "bounded metadata")
        print("WebPageSummaryTests: 9 passed")
    }
}
