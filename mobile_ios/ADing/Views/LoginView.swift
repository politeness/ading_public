import SwiftUI

struct LoginView: View {
    @Environment(AppModel.self) private var app
    @State private var username = ""
    @State private var password = ""
    @State private var server = ServerEnvironment.current
    @State private var signingIn = false
    @State private var error: String?
    /// Developer mode: tap the ADing icon 5 times to open it and choose a server. Memory only; off after every restart.
    @State private var developerMode = false
    @State private var iconTaps = 0

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 10) {
                        Image("ading")
                            .resizable()
                            .scaledToFit()
                            .frame(width: 88, height: 88)
                            #if DEBUG
                            .onTapGesture {
                                iconTaps += 1
                                if iconTaps >= 5 { developerMode = true }
                            }
                            #endif
                        Text("app.name")
                            .font(.title2.bold())
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }
                .listRowBackground(Color.clear)

                Section("login.guide.title") {
                    Text("login.guide.detail")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Link("login.guide.link", destination: URL(string: "https://www.coffeestudy.com.cn/ading/")!)
                }

                Section {
                    TextField("login.username", text: $username)
                        .textContentType(.username)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("login.password", text: $password)
                        .textContentType(.password)
                }

                #if DEBUG
                if developerMode {
                    Section("login.server") {
                        Picker("login.server", selection: $server) {
                            ForEach(ServerEnvironment.selectable) { env in
                                Text(env.title).tag(env)
                            }
                        }
                        .pickerStyle(.segmented)
                        .onChange(of: server) { _, value in ServerEnvironment.current = value }
                    }
                }
                #endif

                if let error {
                    Section {
                        Text(error).foregroundStyle(.red).font(.footnote)
                    }
                }

                Section {
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack {
                            Spacer()
                            if signingIn { ProgressView() } else { Text("login.submit").bold() }
                            Spacer()
                        }
                    }
                    .disabled(username.isEmpty || password.isEmpty || signingIn)
                } footer: {
                    // App Store Review Guideline 1.2: users can message each other, so they must see and agree to the Terms of Service before login
                    Text("login.terms")
                        .font(.footnote)
                        .frame(maxWidth: .infinity)
                        .multilineTextAlignment(.center)
                        .padding(.top, 8)
                }
                Section { FeedbackButton() }
            }
        }
    }

    private func signIn() async {
        signingIn = true
        defer { signingIn = false }
        do {
            try await app.signIn(username: username.trimmingCharacters(in: .whitespaces), password: password)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
