import Foundation

/// Apple's CFBundleShortVersionString stays three numeric parts; ADing's pre-release build time is stored separately in ADingVersion.plist.
/// OTA checks must use the latter to tell apart consecutive TestFlight builds uploaded under the same base version.
enum AppVersion {
    static var display: String {
        if let url = Bundle.main.url(forResource: "ADingVersion", withExtension: "plist"),
           let data = try? Data(contentsOf: url),
           let values = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String],
           let version = values["ADingDisplayVersion"], !version.isEmpty {
            return version
        }
        return Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0.0.0"
    }

    /// Same as desktop and server: a pre-release is lower than the release with the same number; pre-release builds sort by date and time.
    static func isNewer(_ version: String, than current: String) -> Bool {
        guard let next = parse(version), let installed = parse(current) else { return false }
        for index in 0..<3 where next.core[index] != installed.core[index] {
            return next.core[index] > installed.core[index]
        }
        if next.pre.isEmpty || installed.pre.isEmpty {
            return next.pre.isEmpty && !installed.pre.isEmpty
        }
        for (left, right) in zip(next.pre, installed.pre) {
            let order = compareIdentifier(left, right)
            if order != 0 { return order > 0 }
        }
        return next.pre.count > installed.pre.count
    }

    private static func parse(_ text: String) -> (core: [Int], pre: [String])? {
        let noMetadata = text.split(separator: "+", maxSplits: 1, omittingEmptySubsequences: false)[0]
        let parts = noMetadata.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = parts[0].split(separator: ".", omittingEmptySubsequences: false).compactMap { Int($0) }
        guard numbers.count == 3, numbers.allSatisfy({ $0 >= 0 }) else { return nil }
        let pre = parts.count == 2 ? parts[1].split(separator: ".", omittingEmptySubsequences: false).map(String.init) : []
        if parts.count == 2 && (pre.isEmpty || pre.contains("")) { return nil }
        return (numbers, pre)
    }

    private static func compareIdentifier(_ left: String, _ right: String) -> Int {
        let leftDigits = String(left.prefix(while: { $0.isASCII && $0.isNumber }))
        let rightDigits = String(right.prefix(while: { $0.isASCII && $0.isNumber }))
        let leftNumeric = leftDigits.count == left.count
        let rightNumeric = rightDigits.count == right.count
        if !leftDigits.isEmpty && !rightDigits.isEmpty {
            let digits = compareDigits(leftDigits, rightDigits)
            if digits != 0 { return digits }
            return compareText(String(left.dropFirst(leftDigits.count)), String(right.dropFirst(rightDigits.count)))
        }
        if leftNumeric != rightNumeric { return leftNumeric ? -1 : 1 }
        return compareText(left, right)
    }

    private static func compareDigits(_ left: String, _ right: String) -> Int {
        if left.count != right.count { return left.count < right.count ? -1 : 1 }
        return compareText(left, right)
    }

    private static func compareText(_ left: String, _ right: String) -> Int {
        left == right ? 0 : left < right ? -1 : 1
    }
}
