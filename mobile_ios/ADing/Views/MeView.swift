import SwiftUI

struct MeView: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        NavigationStack {
            List {
                if let user = app.user {
                    Section {
                        HStack(spacing: 12) {
                            AvatarView(name: user.displayName, kind: nil, size: 52)
                            VStack(alignment: .leading, spacing: 3) {
                                Text(user.displayName).font(.headline)
                                Text(user.username).font(.subheadline).foregroundStyle(.secondary)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
                Section {
                    NavigationLink { SupportView() } label: {
                        Label("support.title", systemImage: "heart")
                    }
                    FeedbackButton()
                }
            }
            .navigationTitle(L10n.string("tab.me"))
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink { SettingsView() } label: {
                        Image(systemName: "gearshape")
                    }
                    .accessibilityLabel(Text("settings.title"))
                }
            }
        }
    }
}

/// Settings: language, blocked people, about, log out
struct SettingsView: View {
    @Environment(AppModel.self) private var app
    @Environment(LanguageSettings.self) private var settings
    @State private var confirmSignOut = false

    var body: some View {
        @Bindable var settings = settings
        List {
            Section {
                Picker("settings.language", selection: $settings.language) {
                    Text("language.system").tag(AppLanguage.system)
                    // Language names are written in their own language, not translated
                    Text(verbatim: "中文").tag(AppLanguage.zh)
                    Text(verbatim: "English").tag(AppLanguage.en)
                }
            }
            Section {
                NavigationLink("blocked.title") { BlockedListView() }
                NavigationLink("about.title") { AboutView() }
            }
            Section {
                Button("me.signOut", role: .destructive) { confirmSignOut = true }
            }
        }
        .navigationTitle("settings.title")
        .navigationBarTitleDisplayMode(.inline)
        .confirmationDialog("me.signOut.confirm", isPresented: $confirmSignOut, titleVisibility: .visible) {
            Button("me.signOut", role: .destructive) { app.signOut() }
        }
    }
}

/// About: version; development builds also show which server is connected
struct AboutView: View {
    var body: some View {
        List {
            Section {
                #if DEBUG || ADING_PRE
                // Development and TestFlight pre-release builds show the connected environment; App Store builds don't.
                LabeledContent("me.server", value: ServerEnvironment.current.title)
                #endif
                LabeledContent("me.version", value: AppVersion.display)
            }
        }
        .navigationTitle("about.title")
        .navigationBarTitleDisplayMode(.inline)
    }
}
