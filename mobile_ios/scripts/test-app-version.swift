import Foundation

@main
struct AppVersionTests {
    static func main() {
        let cases: [(String, String, Bool)] = [
            ("0.8.0-2026.9.30-111805-pre", "0.8.0-2026.9.30-111804-pre", true),
            ("0.8.0-2026.9.30-000000-pre", "0.8.0-2026.9.9-235959-pre", true),
            ("0.8.0-2026.9.30-111804-pre", "0.8.0-2026.9.30-111805-pre", false),
            ("0.8.0", "0.8.0-2026.9.30-111805-pre", true),
            ("0.8.0-2026.9.30-111805-pre", "0.8.0", false),
            ("0.8.0", "0.8.0-2026.9.30-111805-dev", true),
            ("0.10.0", "0.9.9", true),
            ("0.8", "0.7.0", false),
            ("0.8.0", "0.8.0", false),
        ]
        for (next, current, expected) in cases {
            precondition(AppVersion.isNewer(next, than: current) == expected, "\(next) compared with \(current)")
        }
        print("app-version: \(cases.count) passed")
    }
}
