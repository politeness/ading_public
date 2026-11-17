import SwiftUI

/// Contacts: agents on top, people below. Tapping anyone opens the most recent direct chat with them; if none, a draft opens first and the task is created on the first message.
/// Chatting with an agent remotely puts its computer to work; chatting with a person is ordinary chat.
struct ContactsView: View {
    @Environment(AppModel.self) private var app
    @State private var path: [ChatRoute] = []
    @State private var detailContact: RemoteUser?

    var body: some View {
        NavigationStack(path: $path) {
            List {
                let agents = app.friends.filter(\.isAgent)
                let people = app.friends.filter { !$0.isAgent }
                if !agents.isEmpty {
                    Section("contacts.agents") {
                        ForEach(agents) { agent in
                            HStack(spacing: 10) {
                                Button {
                                    open(agent)
                                } label: {
                                    AgentRow(agent: agent,
                                             unread: app.unreadCount(with: agent.userId),
                                             busy: app.isBusy(agentUserId: agent.userId))
                                }
                                .buttonStyle(.plain)
                                Button { detailContact = agent } label: {
                                    Image(systemName: "info.circle")
                                        .font(.title3)
                                        .frame(width: 32, height: 40)
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel(Text("agent.details"))
                                Chevron()
                            }
                        }
                    }
                }
                if !people.isEmpty {
                    Section("contacts.people") {
                        ForEach(people) { person in
                            HStack(spacing: 10) {
                                Button {
                                    open(person)
                                } label: {
                                    HStack(spacing: 12) {
                                        AvatarView(name: person.displayName, kind: nil)
                                        Text(person.displayName)
                                        Spacer()
                                        UnreadBadge(count: app.unreadCount(with: person.userId))
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Button { detailContact = person } label: {
                                    Image(systemName: "info.circle")
                                        .font(.title3)
                                        .frame(width: 32, height: 40)
                                }
                                .buttonStyle(.borderless)
                                .accessibilityLabel(Text("member.profile.open \(person.displayName)"))
                                Chevron()
                            }
                        }
                    }
                }
            }
            .overlay {
                if app.friends.isEmpty && app.loadError == nil {
                    ContentUnavailableView("contacts.empty.title", systemImage: "person.2",
                                           description: Text("contacts.empty.detail"))
                }
            }
            .navigationTitle(L10n.string("tab.contacts"))
            .navigationDestination(for: ChatRoute.self) { route in
                ChatScreen(route: route)
            }
            .sheet(item: $detailContact) { contact in
                MemberProfileView(profile: MemberProfile(id: contact.userId, name: displayName(for: contact), kind: contact.agentKind))
            }
            .refreshable { await app.refresh() }
            .task {
                await app.refresh()
                while !Task.isCancelled {
                    await app.refreshActivity()
                    try? await Task.sleep(for: .seconds(2))
                }
            }
        }
    }

    private func open(_ contact: RemoteUser) {
        if let conversation = app.directConversation(with: contact.userId) {
            path.append(.conversation(conversation))
        } else {
            path.append(.draft(ConversationDraft(memberIds: [contact.userId])))
        }
    }
}

private struct AgentRow: View {
    let agent: RemoteUser
    let unread: Int
    let busy: Bool

    var body: some View {
        HStack(spacing: 12) {
            AvatarView(name: displayName(for: agent), kind: agent.agentKind)
            VStack(alignment: .leading, spacing: 3) {
                Text(displayName(for: agent)).font(.body.weight(.medium))
                ComputerStatusView(agent: agent)
            }
            Spacer()
            if busy { IkkyuThinking() }
            UnreadBadge(count: unread)
        }
        .contentShape(Rectangle())
    }
}

/// Person whose profile to show after tapping an avatar in chat. May not be a contact (someone else's Agent or friend in a group); only these fields when not found in contacts
struct MemberProfile: Identifiable {
    let id: String
    let name: String
    let kind: AgentKind?
}

/// Agents in Contacts show full details; real-person profiles offer report and block.
struct MemberProfileView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let profile: MemberProfile
    var conversationId: String? = nil
    var onBlocked: () -> Void = {}
    @State private var reporting = false
    @State private var confirmBlock = false
    @State private var blocking = false
    @State private var error: String?

    private var canManage: Bool {
        profile.id != app.user?.userId && profile.kind == nil && app.agent(profile.id)?.isAgent != true
    }

    var body: some View {
        if let agent = app.agent(profile.id), agent.isAgent {
            AgentDetailView(agentId: agent.userId, fallback: agent)
        } else {
            NavigationStack {
                Form {
                    HStack(spacing: 12) {
                        AvatarView(name: profile.name, kind: profile.kind)
                        Text(profile.name).font(.headline)
                    }
                    if let username = app.agent(profile.id)?.username {
                        LabeledContent("member.username", value: username)
                    }
                    if canManage {
                        Section {
                            Button("chat.report", systemImage: "exclamationmark.bubble") { reporting = true }
                            Button("chat.block", systemImage: "hand.raised", role: .destructive) { confirmBlock = true }
                        }
                        .disabled(blocking)
                    }
                    if let error {
                        Section { Text(error).font(.footnote).foregroundStyle(.red) }
                    }
                }
                .sheet(isPresented: $reporting) {
                    ReportView(person: profile.name, userId: profile.id,
                               conversationId: conversationId ?? app.directConversation(with: profile.id)?.conversationId)
                }
                .confirmationDialog(Text("chat.block.confirm \(profile.name)"), isPresented: $confirmBlock, titleVisibility: .visible) {
                    Button("chat.block", role: .destructive) { Task { await block() } }
                } message: {
                    Text("chat.block.detail")
                }
                .navigationTitle("member.profile")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("process.close") { dismiss() }
                    }
                }
            }
        }
    }

    private func block() async {
        guard canManage, !blocking else { return }
        blocking = true
        defer { blocking = false }
        do {
            try await APIClient.shared.block(profile.id)
            await app.refresh()
            onBlocked()
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

private struct AgentDetailView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let agentId: String
    let fallback: RemoteUser
    @State private var requesting = false
    @State private var feedback: String?
    @State private var failed = false

    private var agent: RemoteUser { app.agent(agentId) ?? fallback }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 12) {
                        AvatarView(name: displayName(for: agent), kind: agent.agentKind)
                        Text(displayName(for: agent)).font(.headline)
                    }
                    LabeledContent("agent.kind", value: kindName)
                    LabeledContent("agent.computer", value: agent.computerName ?? L10n.string("computer.generic"))
                    LabeledContent("agent.status", value: statusText)
                }
                Section {
                    Button {
                        Task { await requestRefresh() }
                    } label: {
                        if requesting {
                            ProgressView()
                        } else {
                            Text("agent.refreshStatus")
                        }
                    }
                    .disabled(requesting || agent.computerOnline != true)
                    if let feedback {
                        Text(feedback)
                            .font(.footnote)
                            .foregroundStyle(failed ? Color.red : Color.secondary)
                    }
                }
            }
            .navigationTitle("agent.details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("process.close") { dismiss() }
                }
            }
            .task {
                while !Task.isCancelled {
                    await app.refreshAgents()
                    try? await Task.sleep(for: .seconds(3))
                }
            }
        }
    }

    private var statusText: String {
        let signal = AgentSignal(agent: agent)
        return signal.text.isEmpty ? L10n.string("agent.ready") : signal.text
    }

    private var kindName: String {
        switch agent.agentKind {
        case .codex: "Codex"
        case .claudeCode: "Claude Code"
        case .qoder: "Qoder"
        case .qoderCN: "Qoder CN"
        case .qwenCode: "Qwen Code"
        case .kiro: "Kiro"
        case .copilot: "GitHub Copilot"
        case .antigravity: "Antigravity"
        case nil: agent.agentType ?? "Agent"
        }
    }

    private func requestRefresh() async {
        requesting = true
        defer { requesting = false }
        do {
            try await APIClient.shared.requestAgentVerification(agentId)
            failed = false
            feedback = L10n.string("agent.refreshRequested")
            await app.refreshAgents()
        } catch {
            failed = true
            feedback = error.localizedDescription
        }
    }
}

/// Same red badge as the task list
private struct UnreadBadge: View {
    let count: Int

    var body: some View {
        if count > 0 {
            Text(count > 99 ? "99+" : "\(count)")
                .font(.caption2.bold())
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(Color.red))
        }
    }
}

private struct Chevron: View {
    var body: some View {
        Image(systemName: "chevron.right")
            .font(.footnote)
            .foregroundStyle(.tertiary)
    }
}
