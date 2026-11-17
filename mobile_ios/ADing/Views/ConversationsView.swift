import SwiftUI

/// Task list: same data as desktop; tasks started on phone or computer all appear here. "+" at top right creates a task
struct ConversationsView: View {
    var unreadRequest = 0
    @Environment(AppModel.self) private var app
    @State private var path: [ChatRoute] = []
    @AppStorage("conversations.permanentOnly") private var permanentOnly = false
    @AppStorage("conversations.sharedOnly") private var sharedOnly = false
    private var filtered: [RemoteConversation] {
        app.conversations.filter { AppRules.showsConversation(shared: $0.isShared, permanent: $0.permanent, sharedOnly: sharedOnly, permanentOnly: permanentOnly) }
    }
    @State private var creating = false

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let error = app.loadError {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
                ForEach(filtered) { conversation in
                    NavigationLink(value: ChatRoute.conversation(conversation)) {
                        ConversationRow(conversation: conversation)
                    }
                }
            }
            .listStyle(.plain)
            .overlay {
                if filtered.isEmpty && app.loadError == nil {
                    ContentUnavailableView("conversations.empty.title", systemImage: "checklist",
                                           description: Text("conversations.empty.detail"))
                }
            }
            .navigationTitle(L10n.string("tab.conversations"))
            // Icon filters match desktop.
            .toolbar(.hidden, for: .navigationBar)
            .safeAreaInset(edge: .top, spacing: 0) { header }
            .sheet(isPresented: $creating) {
                NewConversationView { draft in
                    creating = false
                    path.append(.draft(draft))
                }
            }
            .navigationDestination(for: ChatRoute.self) { route in
                ChatScreen(route: route)
            }
            .refreshable { await app.refresh() }
            .onChange(of: unreadRequest) { _, _ in openUnreadConversation() }
            .task(id: PushNotifications.shared.pendingConversationId) { await openPendingConversation() }
            .task {
                // Refresh every 5 seconds while the list is open to see new agent replies from the computer
                while !Task.isCancelled {
                    await app.refreshConversations()
                    try? await Task.sleep(for: .seconds(5))
                }
            }
        }
    }

    private func openUnreadConversation() {
        let unread = app.conversations.filter { ($0.unreadCount ?? 0) > 0 }
        let preferred = unread.first { conversation in
            AppRules.showsConversation(shared: conversation.isShared, permanent: conversation.permanent,
                                       sharedOnly: sharedOnly, permanentOnly: permanentOnly)
        }
        if let conversation = preferred ?? unread.first { path = [.conversation(conversation)] }
    }

    /// Tapped a notification: the conversation may not be in the list yet (just created, or not fetched on cold start); fetch it separately if missing, stay on the list if that fails
    private func openPendingConversation() async {
        guard let id = PushNotifications.shared.pendingConversationId else { return }
        let found: RemoteConversation?
        if let known = app.conversations.first(where: { $0.conversationId == id }) { found = known }
        else { found = try? await APIClient.shared.conversation(id) }
        guard PushNotifications.shared.pendingConversationId == id else { return }
        PushNotifications.shared.pendingConversationId = nil
        if let found { path = [.conversation(found)] }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Text(L10n.string("tab.conversations"))
                .font(.largeTitle.bold())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .accessibilityAddTraits(.isHeader)
            Spacer(minLength: 0)
            categoryFilter(.permanent, selected: $permanentOnly)
            categoryFilter(.shared, selected: $sharedOnly)
            Button {
                creating = true
            } label: {
                Image(systemName: "plus")
                    .font(.title3)
                    .frame(width: 32, height: 44)
            }
            .accessibilityLabel(Text("conversation.new"))
        }
        .padding(.horizontal, 16)
        .background(Color(.systemBackground))
    }
    private func categoryFilter(_ category: ConversationCategory, selected: Binding<Bool>) -> some View {
        Button { selected.wrappedValue.toggle() } label: {
            ConversationCategoryIcon(category: category, emphasized: selected.wrappedValue)
                .frame(width: 20, height: 20)
                .foregroundStyle(selected.wrappedValue ? category.color : Color.secondary)
                .frame(width: 44, height: 44)
        }
        .buttonStyle(.plain)
        .help(Text(category.filterKey))
        .accessibilityLabel(Text(category.filterKey))
        .accessibilityAddTraits(selected.wrappedValue ? .isSelected : [])
    }
}

private enum ConversationCategory {
    case temporary, permanent, shared
    var color: Color {
        switch self {
        case .temporary: .secondary
        case .permanent: Color(red: 0.15, green: 0.39, blue: 0.92)
        case .shared: Color(red: 0.20, green: 0.47, blue: 0.85)
        }
    }
    var labelKey: LocalizedStringKey {
        switch self { case .temporary: "conversations.category.temporary"; case .permanent: "conversations.category.permanent"; case .shared: "conversations.category.shared" }
    }
    var filterKey: LocalizedStringKey {
        switch self { case .temporary: "conversations.temporary"; case .permanent: "conversations.permanentOnly"; case .shared: "conversations.sharedOnly" }
    }
}

private struct ConversationCategoryIcon: View {
    let category: ConversationCategory
    var emphasized = false

    var body: some View {
        GeometryReader { geometry in
            Path { path in
                if category == .permanent {
                    path.move(to: CGPoint(x: 12, y: 12))
                    path.addCurve(to: CGPoint(x: 5.5, y: 7), control1: CGPoint(x: 9, y: 8), control2: CGPoint(x: 7.5, y: 7))
                    path.addCurve(to: CGPoint(x: 5.5, y: 17), control1: CGPoint(x: 0, y: 7), control2: CGPoint(x: 0, y: 17))
                    path.addCurve(to: CGPoint(x: 18.5, y: 7), control1: CGPoint(x: 9, y: 17), control2: CGPoint(x: 15, y: 7))
                    path.addCurve(to: CGPoint(x: 18.5, y: 17), control1: CGPoint(x: 24, y: 7), control2: CGPoint(x: 24, y: 17))
                    path.addCurve(to: CGPoint(x: 12, y: 12), control1: CGPoint(x: 16.5, y: 17), control2: CGPoint(x: 15, y: 16))
                } else if category == .shared {
                    for center in [CGPoint(x: 6, y: 12), CGPoint(x: 18, y: 5), CGPoint(x: 18, y: 19)] {
                        path.addEllipse(in: CGRect(x: center.x - 3, y: center.y - 3, width: 6, height: 6))
                    }
                    path.move(to: CGPoint(x: 8.6, y: 10.5))
                    path.addLine(to: CGPoint(x: 15.4, y: 6.5))
                    path.move(to: CGPoint(x: 8.6, y: 13.5))
                    path.addLine(to: CGPoint(x: 15.4, y: 17.5))
                }
            }
            .applying(CGAffineTransform(scaleX: geometry.size.width / 24, y: geometry.size.height / 24))
            .stroke(style: StrokeStyle(lineWidth: geometry.size.width / 24 * (emphasized ? 2.5 : 2), lineCap: .round, lineJoin: .round))
        }
        .accessibilityHidden(true)
    }
}

private struct ConversationRow: View {
    @Environment(AppModel.self) private var app
    let conversation: RemoteConversation

    var body: some View {
        let others = conversation.members.filter { $0.userId != app.user?.userId }
            .map { member -> (name: String, kind: AgentKind?) in
                let agent = app.agent(member.userId).flatMap { $0.isAgent ? $0 : nil }
                return (displayName(forMember: member, agent: agent), agent?.agentKind)
            }
        HStack(spacing: 12) {
            if conversation.isDirect, let other = others.first {
                AvatarView(name: other.name, kind: other.kind)
            } else {
                GroupAvatar(members: others)
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack {
                    Text(displayTitle(for: conversation, counterpartName: conversation.isDirect ? others.first?.name : nil))
                        .font(.body.weight(.medium))
                        .lineLimit(1)
                    Spacer()
                    if let date = conversation.lastActivity {
                        Text(date, format: .relative(presentation: .named))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                HStack(spacing: 4) {
                    if unreadMention {
                        Text("mention.atMe")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(.red)
                            .fixedSize()
                    }
                    Text(preview)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if category != .temporary {
                        Label { Text(category.labelKey) } icon: {
                            ConversationCategoryIcon(category: category)
                                .frame(width: 14, height: 14)
                        }
                            .labelStyle(.iconOnly)
                            .font(.caption)
                            .foregroundStyle(category.color)
                            .fixedSize()
                    }
                    if let unread = conversation.unreadCount, unread > 0 {
                        Text("\(unread)")
                            .font(.caption2.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.red))
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private var category: ConversationCategory {
        conversation.isShared ? .shared : conversation.permanent ? .permanent : .temporary
    }

    private var unreadMention: Bool {
        conversation.members.first { $0.userId == app.user?.userId }?.hasUnreadMention ?? false
    }

    private var preview: String {
        guard let message = conversation.lastMessage else { return "" }
        if message.content.isEmpty, let first = message.attachments?.first {
            // Only attachments were sent
            if first.isImage { return L10n.string("attachment.preview.image") }
            if first.isVideo { return L10n.string("attachment.preview.video") }
            return L10n.format("attachment.preview.file %@", first.name)
        }
        return message.content.replacingOccurrences(of: "\n", with: " ")
    }
}

/// Group task avatar: overlap at most two member avatars
private struct GroupAvatar: View {
    let members: [(name: String, kind: AgentKind?)]

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            AvatarView(name: members.first?.name ?? "#", kind: members.first?.kind, size: 32)
                .offset(x: -4, y: -4)
            if members.count > 1 {
                AvatarView(name: members[1].name, kind: members[1].kind, size: 26)
                    .offset(x: 2, y: 2)
            }
        }
        .frame(width: 40, height: 40)
    }
}
