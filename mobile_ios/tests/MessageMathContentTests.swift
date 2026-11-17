import Foundation
@main struct MessageMathContentTests {
    static func main() {
        for text in [#"\(n\)"#, #"\[\begin{aligned}a&=b\\&=c\end{aligned}\]"#, "$x^2$", "$$x^2$$"] {
            precondition(MessageMathContent.containsFormula(text), text)
        }
        for text in ["普通文字", "$5 and $10", #"\$5"#, "```tex\n$x$\n```", "`$x$`", #"\[unfinished"#] {
            precondition(!MessageMathContent.containsFormula(text), text)
        }
        print("MessageMathContent: 10 cases passed")
    }
}
