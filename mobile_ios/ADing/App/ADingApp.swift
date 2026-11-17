import SwiftUI

/// ADing mobile: remotely put ADing on your computer to work.
/// The phone runs no agent: messages are written to the cloud, the desktop ADing (signed in to the same account and running) picks them up and hands them to the agent on the computer, and replies sync back.
@main
struct ADingApp: App {
    @State private var app = AppModel()
    @State private var updateGate = UpdateGate()
    @State private var language = LanguageSettings.shared
    /// Follow-up results of tip transactions (extra verification, previously unfinished ones) must be observed for the whole App lifetime
    @State private var tipTransactions = TipTransactions.listen()
    @UIApplicationDelegateAdaptor(PushAppDelegate.self) private var pushDelegate
    @Environment(\.scenePhase) private var scenePhase
    @State private var foreground = AppRules.ForegroundTracker()

    init() {
        // Move login state saved by older versions to where the share extension can also read it
        Credentials.shareWithExtensions()
    }

    var body: some Scene {
        WindowGroup {
            Group {
                if updateGate.requiredVersion != nil {
                    UpdateRequiredView()
                } else if app.isSignedIn {
                    MainTabView()
                } else {
                    LoginView()
                }
            }
            // Rebuild the whole UI on language change: the system tab bar and status text fetched via L10n don't refresh on their own;
            // without a rebuild they stay in the previous language. MainTabView remembers the current tab, so the rebuild doesn't jump away
            .id(language.language)
            .task(id: scenePhase) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await ProblemFeedbackQueue.shared.flush()
                    do { try await Task.sleep(for: .seconds(60)) } catch { break }
                }
            }
            .environment(app)
            .environment(updateGate)
            .environment(language)
            // UI language: chosen in Settings, follows the system by default; switching changes the whole UI immediately
            .environment(\.locale, language.locale)
            .onChange(of: language.language) { _, _ in app.syncPush() }
            // Explicitly fetch cloud data once on first launch instead of waiting for a scenePhase change: on cold start the active change isn't guaranteed to fire.
            // Computer names in Contacts come from the server, so after a computer is renamed the next launch picks up the new name.
            .task {
                app.setForeground(true)
                async let updateCheck: Void = updateGate.check()
                async let dataRefresh: Void = app.refresh()
                _ = await (updateCheck, dataRefresh)
            }
            // Only disconnect/reconnect on real background transitions; on returning from background, re-check forced update (may have just been released) and catch up on data
            .onChange(of: scenePhase) { _, phase in
                switch foreground.change(to: phase) {
                case .leave:
                    app.setForeground(false)
                case .resume:
                    app.setForeground(true)
                    Task { await updateGate.check() }
                    Task { await app.refresh() }
                case .none:
                    break
                }
            }
        }
    }
}

struct MainTabView: View {
    @Environment(AppModel.self) private var app
    @State private var unreadRequest = 0
    @SceneStorage("mainTab") private var tab = 0
    private let push = PushNotifications.shared

    var body: some View {
        TabView(selection: $tab) {
            ConversationsView(unreadRequest: unreadRequest)
                .tabItem {
                    Label { Text(L10n.string("tab.chats")) } icon: {
                        Image(uiImage: tabIcon("checklist", unread: app.conversations.contains { ($0.unreadCount ?? 0) > 0 }, selected: tab == 0))
                    }
                }
                .tag(0)
            ContactsView()
                .tabItem {
                    Label { Text(L10n.string("tab.contacts")) } icon: {
                        Image(uiImage: tabIcon("person.2", unread: app.friends.contains { app.unreadCount(with: $0.userId) > 0 }, selected: tab == 1))
                    }
                }
                .tag(1)
            MeView()
                .tabItem { Label(L10n.string("tab.me"), systemImage: "person.crop.circle") }
                .tag(2)
        }
        .background(ConversationTabDoubleTap {
            tab = 0
            unreadRequest += 1
        })
        // Conversations opened from a notification live in the first tab
        .onChange(of: push.pendingConversationId) { _, id in
            if id != nil { tab = 0 }
        }
        .onAppear {
            if push.pendingConversationId != nil { tab = 0 }
        }
    }
    /// Include the six-point indicator in the public tab-item image itself.
    /// Native tab-bar subview nesting changes between iOS releases.
    private func tabIcon(_ symbol: String, unread: Bool, selected: Bool) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: 34, height: 29))
        return renderer.image { context in
            let color: UIColor = selected ? .systemBlue : .secondaryLabel
            let image = UIImage(systemName: symbol, withConfiguration: UIImage.SymbolConfiguration(pointSize: 23, weight: .regular))?
                .withTintColor(color, renderingMode: .alwaysOriginal)
            if let image {
                let size = image.size
                image.draw(in: CGRect(x: (34-size.width)/2, y: (29-size.height)/2, width: size.width, height: size.height))
            }
            if unread {
                context.cgContext.setFillColor(UIColor.systemRed.cgColor)
                context.cgContext.fillEllipse(in: CGRect(x: 27, y: 0, width: 6, height: 6))
            }
        }.withRenderingMode(.alwaysOriginal)
    }
}

/// Observe the native tab bar without delaying or cancelling its normal single taps.
private struct ConversationTabDoubleTap: UIViewControllerRepresentable {
    var action: () -> Void

    func makeUIViewController(context: Context) -> Observer { Observer() }

    func updateUIViewController(_ controller: Observer, context: Context) {
        controller.action = action
        DispatchQueue.main.async { controller.attach() }
    }

    static func dismantleUIViewController(_ controller: Observer, coordinator: ()) {
        controller.detach()
    }

    final class Observer: UIViewController, UIGestureRecognizerDelegate {
        var action: (() -> Void)?
        private weak var observedBar: UITabBar?

        private lazy var doubleTap: UITapGestureRecognizer = {
            let gesture = UITapGestureRecognizer(target: self, action: #selector(tapped(_:)))
            gesture.numberOfTapsRequired = 2
            gesture.cancelsTouchesInView = false
            gesture.delaysTouchesBegan = false
            gesture.delaysTouchesEnded = false
            gesture.delegate = self
            return gesture
        }()

        override func viewDidAppear(_ animated: Bool) {
            super.viewDidAppear(animated)
            attach()
        }

        func attach() {
            // The representable is a background sibling of SwiftUI's tab controller.
            func findTabs(_ controller: UIViewController) -> UITabBarController? {
                if let tabs = controller as? UITabBarController { return tabs }
                return controller.children.lazy.compactMap { findTabs($0) }.first
            }
            guard let bar = (tabBarController ?? view.window?.rootViewController.flatMap { findTabs($0) })?.tabBar else { return }
            if observedBar === bar { return }
            detach()
            observedBar = bar
            bar.addGestureRecognizer(doubleTap)

        }

        func detach() {
            observedBar?.removeGestureRecognizer(doubleTap)
            observedBar = nil
        }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                               shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }

        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
            guard let bar = observedBar else { return false }
            func controls(in view: UIView) -> [UIControl] {
                view.subviews.flatMap { child -> [UIControl] in
                    if let control = child as? UIControl, control.bounds.width > 30, control.bounds.height > 20 { return [control] }
                    return controls(in: child)
                }
            }
            let buttons = controls(in: bar).sorted { $0.convert($0.bounds, to: bar).minX < $1.convert($1.bounds, to: bar).minX }
            guard let first = buttons.first else { return false }
            return first.convert(first.bounds, to: bar).contains(touch.location(in: bar))
        }

        @objc private func tapped(_ gesture: UITapGestureRecognizer) {
            if gesture.state == .ended { action?() }
        }
    }
}
