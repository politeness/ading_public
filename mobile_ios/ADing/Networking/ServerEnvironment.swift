import Foundation

/// Which backend the phone connects to. Maps one-to-one to desktop's three environments: develop (NAS, reachable only on the home LAN), pre-release, production.
enum ServerEnvironment: String, CaseIterable, Identifiable {
    case develop, pre, release

    var id: String { rawValue }

    var baseURL: URL {
        switch self {
        case .develop:
            // The develop server address isn't in the repo: Build.local.xcconfig writes it into Info.plist at build time; falls back to localhost if unset
            let host = Bundle.main.object(forInfoDictionaryKey: "AdingDevelopHost") as? String
            return URL(string: "http://" + (host?.isEmpty == false ? host! : "localhost:8080"))!
        case .pre: return URL(string: "https://www.coffeestudy.com.cn/pre")!
        case .release: return URL(string: "https://www.coffeestudy.com.cn")!
        }
    }

    var title: String {
        switch self {
        case .develop: L10n.string("server.develop")
        case .pre: L10n.string("server.pre")
        case .release: L10n.string("server.release")
        }
    }

    private static let key = "serverEnvironment"

#if DEBUG
    /// Development builds default to pre-release, reachable from anywhere. The develop environment requires the home LAN and switching manually in developer mode
    /// Stored in UserDefaults shared with the share extension: the extension must connect to the same server
    static var current: ServerEnvironment {
        get { SharedStore.migratedString(key).flatMap(ServerEnvironment.init(rawValue:)) ?? .pre }
        set { SharedStore.defaults.set(newValue.rawValue, forKey: key) }
    }

    /// Servers selectable in developer mode
    static var selectable: [ServerEnvironment] { allCases }
#elseif ADING_PRE
    /// TestFlight pre-release builds always connect to the pre-release backend, with no developer switch, so they never hit production data by mistake.
    static var current: ServerEnvironment {
        get { .pre }
        set {}
    }
#else
    /// App Store builds only connect to production, with no switch (App Review disallows hidden features)
    static var current: ServerEnvironment {
        get { .release }
        set {}
    }
#endif
}
