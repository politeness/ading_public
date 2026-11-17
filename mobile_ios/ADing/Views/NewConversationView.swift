import SwiftUI

/// New task: pick members (agents on top, people below), then open a draft; the task is only actually created on the first message.
///
/// Group chats automatically include Agent owners; every real person must own or be allowed to use all Agents.
struct NewConversationView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let onStart: (ConversationDraft) -> Void

    @State private var selected: [String] = []
    @State private var permanent = false
    @State private var leaderId: String?

    private var agents: [RemoteUser] { app.friends.filter(\.isAgent) }
    private var people: [RemoteUser] { app.friends.filter { !$0.isAgent } }
    private var selectedAgents: [String] { selected.filter { id in agents.contains { $0.userId == id } } }
    private var requiredOwners: Set<String> { Set(selectedAgents.compactMap { app.agent($0)?.owner }) }

    var body: some View {
        NavigationStack {
            List {
                Section { Toggle("conversation.permanent", isOn: $permanent) }
                if !agents.isEmpty {
                    Section {
                        ForEach(agents) { agent in
                            row(agent, disabled: !selected.contains(agent.userId) && !app.canJoinTogether(selected + [agent.userId])) {
                                HStack(spacing: 12) {
                                    AvatarView(name: displayName(for: agent), kind: agent.agentKind)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(displayName(for: agent))
                                        ComputerStatusView(agent: agent)
                                    }
                                }
                            }
                        }
                    } header: {
                        Text("contacts.agents")
                    } footer: {

                    }
                }
                if !people.isEmpty {
                    Section {
                        ForEach(people) { person in
                            row(person, disabled: requiredOwners.contains(person.userId) || (!selected.contains(person.userId) && !app.canJoinTogether(selected + [person.userId]))) {
                                HStack(spacing: 12) {
                                    AvatarView(name: person.displayName, kind: nil)
                                    Text(person.displayName)
                                }
                            }
                        }
                    } header: {
                        Text("contacts.people")
                    } footer: {

                    }
                }
            }
            .overlay {
                if app.friends.isEmpty {
                    ContentUnavailableView("contacts.empty.title", systemImage: "person.2",
                                           description: Text("contacts.empty.detail"))
                }
            }
            .navigationTitle("conversation.new")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("conversation.new.cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("conversation.new.start") {
                        onStart(ConversationDraft(memberIds: selected, leaderId: selectedAgents.count > 1 ? leaderId : nil, permanent: permanent))
                    }
                    .disabled(selected.isEmpty)
                }
            }
        }
    }

    private func row<Label: View>(_ user: RemoteUser, disabled: Bool, @ViewBuilder label: () -> Label) -> some View {
        let isSelected = selected.contains(user.userId)
        return HStack(spacing: 12) {
            Button {
                toggle(user.userId)
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                        .font(.title3)
                        .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                    label()
                    Spacer()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(disabled)
            if user.isAgent, isSelected, selectedAgents.count > 1 {
                let isLeader = leaderId == user.userId
                Button {
                    leaderId = user.userId
                } label: {
                    Image(systemName: isLeader ? "crown.fill" : "crown")
                        .foregroundStyle(isLeader ? Color.yellow : Color.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(Text(isLeader ? "conversation.leader" : "conversation.setLeader"))
            }
        }
        .opacity(disabled ? 0.4 : 1)
    }

    private func toggle(_ userId: String) {
        if let index = selected.firstIndex(of: userId) {
            selected.remove(at: index)
        } else {
            selected = app.withAgentOwners(selected + [userId])
        }
        // The leader defaults to the first selected agent; if the leader is deselected, it moves to the next one
        if leaderId == nil || !selectedAgents.contains(leaderId!) {
            leaderId = selectedAgents.first
        }
    }
}
