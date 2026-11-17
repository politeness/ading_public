import SwiftUI

/// Report a person: pick a reason, optionally add a note. The server attaches their recent messages in this task and hands it to the developer.
struct ReportView: View {
    @Environment(\.dismiss) private var dismiss
    let person: String
    let userId: String
    let conversationId: String?

    @State private var reason: ReportReason?
    @State private var detail = ""
    @State private var sending = false
    @State private var error: String?
    @State private var done = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(ReportReason.allCases) { item in
                        Button {
                            reason = item
                        } label: {
                            HStack {
                                Text(item.title).foregroundStyle(Color.primary)
                                Spacer()
                                if reason == item { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                } header: {
                    Text("report.reason")
                }
                Section {
                    TextField("report.detail", text: $detail, axis: .vertical)
                        .lineLimit(3...6)
                } footer: {
                    Text("report.footer")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle(Text("report.title \(person)"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("conversation.new.cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if sending {
                        ProgressView()
                    } else {
                        Button("report.submit") { Task { await submit() } }
                            .disabled(reason == nil)
                    }
                }
            }
            .alert("report.done", isPresented: $done) {
                Button("process.close") { dismiss() }
            } message: {
                Text("report.done.detail")
            }
        }
    }

    private func submit() async {
        guard let reason else { return }
        sending = true
        defer { sending = false }
        do {
            try await APIClient.shared.report(userId, reason: reason,
                                              detail: detail.trimmingCharacters(in: .whitespacesAndNewlines), conversationId: conversationId)
            error = nil
            done = true
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// People I've blocked can be unblocked here. Unblocking doesn't restore the friendship; they must be added again
struct BlockedListView: View {
    @Environment(AppModel.self) private var app
    @State private var people: [RemoteUser] = []
    @State private var loaded = false
    @State private var error: String?

    var body: some View {
        List {
            if let error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
            ForEach(people) { person in
                HStack(spacing: 12) {
                    AvatarView(name: person.displayName, kind: nil, size: 36)
                    Text(person.displayName)
                    Spacer()
                    Button("blocked.unblock") { Task { await unblock(person) } }
                        .buttonStyle(.bordered)
                }
            }
        }
        .overlay {
            if loaded && people.isEmpty && error == nil {
                ContentUnavailableView("blocked.empty", systemImage: "hand.raised")
            }
        }
        .navigationTitle("blocked.title")
        .task { await load() }
        .refreshable { await load() }
    }

    private func load() async {
        do {
            people = try await APIClient.shared.blocked()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
        loaded = true
    }

    private func unblock(_ person: RemoteUser) async {
        do {
            try await APIClient.shared.unblock(person.userId)
            people.removeAll { $0.userId == person.userId }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}
