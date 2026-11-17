import Foundation
import Observation

/// State of "Settings → Language". Takes effect immediately, no restart: the root view injects `locale`, text outside the UI goes through L10n.
@MainActor
@Observable
final class LanguageSettings {
    static let shared = LanguageSettings()

    var language: AppLanguage {
        didSet { SharedStore.defaults.set(language.rawValue, forKey: AppLanguage.storageKey) }
    }

    var locale: Locale { language.locale }

    private init() {
        language = AppLanguage.saved
    }
}
