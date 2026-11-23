import Foundation

/// UI language: follows the system by default, or can be pinned to Chinese or English in the App's "Settings → Language".
/// The choice is stored in storage shared by the App and the "Share to ADing" extension, so the extension shows the same language as the App.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system, zh, en

    static let storageKey = "appLanguage"

    var id: String { rawValue }

    /// Localization bundle directory name; empty when following the system, so the system's pick is used
    var localization: String? {
        switch self {
        case .system: nil
        case .zh: "zh-Hans"
        case .en: "en"
        }
    }

    static var saved: AppLanguage {
        SharedStore.defaults.string(forKey: storageKey).flatMap(AppLanguage.init(rawValue:)) ?? .system
    }

    /// The locale injected into SwiftUI: the system's current one when following the system
    var locale: Locale {
        localization.map(Locale.init(identifier:)) ?? .autoupdatingCurrent
    }
}

/// Text lookup outside the UI (error messages, status text). Uses the same Localizable.strings as SwiftUI, with the language from Settings.
/// SwiftUI's Text / Button etc. look up text by the locale injected at the root view, not through here.
enum L10n {
    static var bundle: Bundle {
        guard let localization = AppLanguage.saved.localization,
              let path = Bundle.main.path(forResource: localization, ofType: "lproj"),
              let bundle = Bundle(path: path) else { return .main }
        return bundle
    }

    static func string(_ key: String) -> String {
        bundle.localizedString(forKey: key, value: nil, table: nil)
    }

    /// Text for a key, or nil when the strings file doesn't have it
    static func optional(_ key: String) -> String? {
        let missing = "\u{0}"
        let text = bundle.localizedString(forKey: key, value: missing, table: nil)
        return text == missing ? nil : text
    }

    /// Text with arguments; key names match Localizable.strings (e.g. "error.network %@")
    static func format(_ key: String, _ arguments: CVarArg...) -> String {
        String(format: string(key), locale: AppLanguage.saved.locale, arguments: arguments)
    }

    /// Message time, same rules as desktop formatTime: omit the date only for today, write "Yesterday" for yesterday, add month/day within this year, add the year across years.
    /// Differences are by calendar day, not 24 hours: 23:00 last night and 01:00 this morning are two hours apart but really are yesterday
    static func time(_ date: Date, now: Date = Date()) -> String {
        let locale = AppLanguage.saved.locale
        var calendar = Calendar.current
        calendar.locale = locale
        // Hours and minutes are always 24-hour, never AM/PM by region
        let clock = formatter("HHmm", locale).string(from: date)
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        if days <= 0 { return clock }
        if days == 1 { return format("time.yesterday %@", clock) }
        let sameYear = calendar.component(.year, from: date) == calendar.component(.year, from: now)
        let day = formatter(sameYear ? "MMMMd" : "yMMMMd", locale).string(from: date)
        return format("time.dated %@ %@", day, clock)
    }

    private static func formatter(_ template: String, _ locale: Locale) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.setLocalizedDateFormatFromTemplate(template)
        return formatter
    }
}
