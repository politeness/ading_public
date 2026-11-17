import AVFoundation
import PhotosUI
import SwiftUI

/// Chat: messages from the phone are written to the cloud, desktop ADing picks them up and hands them to the agent on the computer, and replies are written back to the cloud and shown here.
/// Chatting with people uses the same page, just without an agent. It can open an existing task or a draft (the task is created on the first message).
struct ChatView: View {
    @Environment(AppModel.self) private var app
    @State private var conversation: RemoteConversation?
    @State private var draft: ConversationDraft?
    @State private var chat: ChatModel
    @State private var text = ""
    @State private var ownerControlPending = false
    @State private var pickedMentions: [String: String] = [:]
    /// @-mentions read on open: once marked read they can't be queried, so record them for the floating button and drop them once tapped
    @State private var mentionJumpSeq: Int?
    @State private var flashedMessageId: String?
    @State private var showingActivity = false
    @State private var blockedContact = false
    @State private var addingMembers = false
    /// Message being replied to
    @State private var replying: ReplyTarget?
    /// Person whose profile to show after tapping an avatar
    @State private var profile: MemberProfile?
    /// Attachments above the composer not yet sent
    @State private var pending: [LocalAttachment] = []
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var pickingFiles = false
    @State private var takingPhoto = false
    /// Copying selected photos/files in
    @State private var preparing = false
    @Environment(\.dismiss) private var dismiss
    @FocusState private var composing: Bool
    /// Conversation switched to via "Switch task"/"New task" at top right; ChatScreen replaces the current page in place
    private let onSwitch: (ChatRoute) -> Void

    init(route: ChatRoute, onSwitch: @escaping (ChatRoute) -> Void = { _ in }) {
        self.onSwitch = onSwitch
        switch route {
        case .conversation(let conversation):
            _conversation = State(initialValue: conversation)
            _chat = State(initialValue: ChatModel(conversationId: conversation.conversationId))
        case .draft(let draft):
            _draft = State(initialValue: draft)
            _chat = State(initialValue: ChatModel(conversationId: nil))
        }
    }

    private var me: String? { app.user?.userId }
    /// Members other than self
    private var memberIds: [String] {
        if let conversation { return conversation.members.map(\.userId).filter { $0 != me } }
        return draft?.memberIds ?? []
    }
    private var agents: [RemoteUser] { memberIds.compactMap { app.agent($0) }.filter(\.isAgent) }

    private func name(of userId: String) -> String {
        if let user = app.agent(userId) { return displayName(for: user) }
        return conversation?.members.first { $0.userId == userId }?.displayName ?? userId
    }

    /// Like desktop, the header shows "who the other side is" rather than the task name: the other person's name in a direct chat, "All members" for groups
    private var headerName: String {
        memberIds.count == 1 ? name(of: memberIds[0]) : L10n.string("chat.allMembers")
    }

    /// Header avatar: the other person's avatar in a direct chat, a member collage for groups
    private var headerMembers: [(name: String, kind: AgentKind?)] {
        memberIds.map { id in (name(of: id), app.agent(id).flatMap { $0.isAgent ? $0.agentKind : nil }) }
    }

    /// Like desktop: direct chats list all conversations with this contact; groups list group chats with exactly the same members (excluding self). Most recently active first
    private var switchCandidates: [RemoteConversation] {
        let list: [RemoteConversation]
        if memberIds.count == 1 {
            let contact = memberIds[0]
            list = app.conversations.filter { $0.members.contains { $0.userId == contact } }
        } else if !memberIds.isEmpty {
            let target = Set(memberIds)
            list = app.conversations.filter { !$0.isDirect && Set($0.members.map(\.userId).filter { $0 != me }) == target }
        } else {
            list = []
        }
        return list.sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
    }

    /// A group draft is itself new and has no other conversation to switch to (same as desktop: button greyed out)
    private var switchDisabled: Bool { conversation == nil && memberIds.count > 1 }

    /// Unread in other conversations: show a red dot on the switch button
    private var switchHasUnread: Bool {
        switchCandidates.contains { $0.conversationId != conversation?.conversationId && ($0.unreadCount ?? 0) > 0 }
    }

    private func conversationMeta(_ conversation: RemoteConversation) -> String {
        guard (conversation.status ?? "ACTIVE") == "ACTIVE" else { return L10n.string("chat.conversation.completed") }
        if !conversation.isDirect { return L10n.format("chat.conversation.memberCount %lld", conversation.members.count) }
        if let other = conversation.members.first(where: { $0.userId != me }) { return name(of: other.userId) }
        return L10n.string("chat.conversation.inProgress")
    }

    private func conversationTitle(_ conversation: RemoteConversation) -> String {
        let others = conversation.members.map(\.userId).filter { $0 != me }
        return displayTitle(for: conversation, counterpartName: others.count == 1 ? name(of: others[0]) : nil)
    }

    /// New group chats keep the current leader
    private var leaderId: String? {
        guard memberIds.count > 1 else { return nil }
        return conversation?.members.first { $0.role == "LEADER" }?.userId ?? draft?.leaderId
    }

    /// Members include my own Agent; chats with only real people have no Activity to view
    private var hasAgent: Bool {
        memberIds.contains { app.agent($0)?.isAgent == true }
    }

    private var busy: Bool {
        guard let id = chat.conversationId else { return false }
        return app.isBusy(id)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let offline = agents.first(where: { $0.computerOnline != true }) {
                OfflineBanner(agent: offline)
            }
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(chat.visibleMessages) { message in
                            MessageRow(message: message, mine: message.senderId == me, sender: sender(of: message),
                                       mentions: mentionHighlights(for: message),
                                       onAvatar: {
                                           let sender = sender(of: message)
                                           profile = MemberProfile(id: message.senderId, name: sender.name, kind: sender.kind)
                                       },
                                       onMention: isGroupChat ? { mention(message.senderId) } : nil,
                                       quoteSender: message.extra?.quote.map { name(of: $0.senderId) },
                                       onReply: { startReply(message) },
                                       onQuote: {
                                           guard let target = message.replyTo,
                                                 chat.visibleMessages.contains(where: { $0.messageId == target }) else { return }
                                           withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .center) }
                                           flash(target)
                                       })
                                .id(message.messageId)
                                .background(flashedMessageId == message.messageId ? Color.red.opacity(0.12) : Color.clear,
                                            in: RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                }
                .scrollDismissesKeyboard(.interactively)
                // Activity: floats at the bottom right of the message area like desktop (a draft has no task yet, so nothing to view)
                .overlay(alignment: .bottomTrailing) {
                    if chat.conversationId != nil {
                        // Chats with real people have no Agent working, so Activity is empty: keep the button but greyed out and disabled
                        FloatingButton(label: "process.title") { showingActivity = true } icon: {
                            ActivityIcon()
                        }
                        .disabled(!hasAgent)
                        .opacity(hasAgent ? 1 : 0.4)
                        .padding(.trailing, 16)
                        .padding(.bottom, 12)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if let target = mentionJumpTarget {
                        Button {
                            mentionJumpSeq = nil
                            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target.messageId, anchor: .center) }
                            flash(target.messageId)
                        } label: {
                            Text("mention.jump")
                                .font(.footnote.weight(.semibold))
                                .foregroundStyle(.red)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 7)
                                .background(Capsule().fill(Color(.systemBackground)).shadow(radius: 3))
                        }
                        .padding(.trailing, 12)
                        .padding(.top, 8)
                    }
                }
                .onAppear {
                    guard mentionJumpSeq == nil, let mine = conversation?.members.first(where: { $0.userId == app.user?.userId }),
                          mine.hasUnreadMention else { return }
                    mentionJumpSeq = mine.firstUnreadMentionSeq
                }
                .onChange(of: chat.visibleMessages.last?.messageId) { _, _ in scrollToBottom(proxy) }
                .onChange(of: composing) { _, focused in if focused { scrollToBottom(proxy) } }
            }
            if let error = chat.error {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .padding(.horizontal)
                    .padding(.top, 4)
            }
            if readOnly {
                HStack {
                    Text("chat.sharedReadOnly")
                        .font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                    if ownsSharedAgent {
                        Button { changeOwnerPause() } label: {
                            Image(systemName: ownerPaused ? "play.fill" : "pause.fill")
                                .frame(width: 44, height: 44)
                        }
                        .disabled(ownerControlPending || (ownerPaused && busy))
                        .accessibilityLabel(Text(ownerPaused ? "chat.ownerResume" : "chat.ownerPause"))
                    }
                }
                .padding(.horizontal)
            } else {
                composer
            }
        }
        .navigationTitle(headerName)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // Same as desktop header: other party's avatar (member collage for groups) + name; Ikkyu shown beside it while an agent is working
            // (status comes from the real execution state the computer reports to the server)
            ToolbarItem(placement: .principal) {
                HStack(spacing: 6) {
                    MemberCollage(members: headerMembers)
                    Text(headerName).font(.headline).lineLimit(1)
                    if busy { IkkyuThinking() }
                }
            }
        }
        .toolbar {
            // Same as desktop header: switch conversation (first item is always New conversation) + add member
            ToolbarItemGroup(placement: .topBarTrailing) {
                switcherMenu
                Button {
                    addingMembers = true
                } label: {
                    Image(systemName: "person.badge.plus")
                }
                .disabled(readOnly || memberIds.isEmpty)
                .accessibilityLabel(Text("chat.addMembers"))
            }
        }
        .sheet(item: $profile, onDismiss: {
            if blockedContact {
                blockedContact = false
                dismiss()
            }
        }) { selectedProfile in
            MemberProfileView(profile: selectedProfile, conversationId: chat.conversationId,
                              onBlocked: {
                                  if memberIds.count == 1 && memberIds.first == selectedProfile.id {
                                      blockedContact = true
                                  }
                              })
        }
        .sheet(isPresented: $addingMembers) {
            AddMembersSheet(candidates: addCandidates, add: addMember)
        }
        .sheet(isPresented: $showingActivity) {
            if let conversationId = chat.conversationId {
                ActivityView(conversationId: conversationId, chat: chat, name: name(of:))
            }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraAttachmentView { image in
                takingPhoto = false
                prepare([image]) { try PhotoAttachmentLoader.load($0) }
            }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems,
                      maxSelectionCount: max(1, LocalAttachment.maxCount - pending.count),
                      matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            prepare(items) { try await PhotoAttachmentLoader.load($0) }
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                prepare(urls) { try LocalAttachment.copying($0) }
            case .failure(let error):
                chat.error = error.localizedDescription
            }
        }
        .onAppear { chat.start() }
        .onReceive(NotificationCenter.default.publisher(for: .mqttConversationChanged)) { event in
            guard event.object == nil || (event.object as? String) == chat.conversationId else { return }
            Task { await chat.pull() }
        }
        .onDisappear { chat.stop() }
        .task {
            guard !agents.isEmpty else { return }
            while !Task.isCancelled {
                await app.refreshActivity()
                if let updated = app.conversations.first(where: { $0.conversationId == chat.conversationId }) {
                    conversation = updated
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    /// Switch-conversation menu: first item "New conversation" (opens another with the current members; it's the current item when already in a new one), then switchable conversations
    private var switcherMenu: some View {
        Menu {
            Section {
                Button {
                    if conversation != nil { onSwitch(.draft(ConversationDraft(memberIds: memberIds, leaderId: leaderId))) }
                } label: {
                    Label("chat.newConversation", systemImage: conversation == nil ? "checkmark" : "plus")
                }
                .disabled(readOnly || memberIds.isEmpty)
            }
            Section {
                ForEach(switchCandidates) { candidate in
                    let current = candidate.conversationId == conversation?.conversationId
                    let unread = !current && (candidate.unreadCount ?? 0) > 0
                    Button {
                        if !current { onSwitch(.conversation(candidate)) }
                    } label: {
                        if current {
                            Label(conversationTitle(candidate), systemImage: "checkmark")
                        } else if unread {
                            Label(conversationTitle(candidate), systemImage: "circle.fill")
                        } else {
                            Text(conversationTitle(candidate))
                        }
                        Text(conversationMeta(candidate))
                    }
                }
                if switchCandidates.isEmpty {
                    Text("chat.noConversations")
                }
            }
        } label: {
            Image(systemName: "text.line.last.and.arrowtriangle.forward")
                .overlay(alignment: .topTrailing) {
                    if switchHasUnread && !switchDisabled {
                        Circle().fill(Color.red).frame(width: 7, height: 7).offset(x: 3, y: -2)
                    }
                }
        }
        .disabled(switchDisabled)
        .accessibilityLabel(Text(switchDisabled ? "chat.alreadyNew" : "chat.switchConversation"))
    }

    /// Contacts that can be added: every real person must own or be allowed to use all Agents, and Agent owners are included.
    /// Existing conversations use each member's own isAgent, counting members not in my friend list too; draft members are all picked from friends
    private var addCandidates: [RemoteUser] {
        if readOnly { return [] }
        return app.friends.filter { user in
            user.userId != me && !memberIds.contains(user.userId)
                && app.canJoinTogether(memberIds + [user.userId])
        }
    }

    /// Like desktop: group chats add the person directly; direct chats can't add people, so open a group chat draft with the other party and the new person, leaving the direct chat untouched;
    /// adding during the draft stage just appends to the draft members
    private func addMember(_ user: RemoteUser) async {
        guard !readOnly else { return }
        if let conversation, !conversation.isDirect {
            do {
                try await APIClient.shared.addMember(user.userId, to: conversation.conversationId)
                let updated = try await APIClient.shared.conversation(conversation.conversationId)
                self.conversation = updated
                if let index = app.conversations.firstIndex(where: { $0.conversationId == updated.conversationId }) {
                    app.conversations[index] = updated
                }
            } catch {
                chat.error = error.localizedDescription
            }
            return
        }
        let members = app.withAgentOwners(memberIds + [user.userId])
        let agentIds = members.filter { app.agent($0)?.isAgent == true }
        // Multiple agents need a leader: keep the one chosen in the draft, otherwise the first one present (same default as new conversation)
        let leader = agentIds.count > 1 ? (draft?.leaderId.flatMap { agentIds.contains($0) ? $0 : nil } ?? agentIds.first) : nil
        addingMembers = false
        onSwitch(.draft(ConversationDraft(memberIds: members, leaderId: leader, permanent: draft?.permanent ?? false)))
    }

    private var placeholder: LocalizedStringKey {
        if !agents.isEmpty { return "chat.placeholder" }
        if memberIds.count == 1 { return "chat.placeholder.person \(name(of: memberIds[0]))" }
        return "chat.placeholder.group"
    }

    /// The + menu for adding images and files
    private var attachMenu: some View {
        Menu {
            Button("chat.attach.photos", systemImage: "photo.on.rectangle") { pickingPhotos = true }
            Button("chat.attach.camera", systemImage: "camera") { openCamera() }
            Button("chat.attach.files", systemImage: "folder") { pickingFiles = true }
        } label: {
            Group {
                if preparing {
                    ProgressView()
                } else {
                    Image(systemName: "plus.circle")
                        .font(.system(size: 24))
                }
            }
            .frame(width: 36, height: 36)
        }
        .disabled(chat.sending || preparing || pending.count >= LocalAttachment.maxCount)
        .menuOrder(.fixed)
        .accessibilityLabel(Text("chat.attach"))
    }

    private var mentionQuery: String? {
        // A direct chat has only one target, so @ needs no picker
        guard isGroupChat, let at = text.lastIndex(of: "@") else { return nil }
        let query = String(text[text.index(after: at)...])
        // Whitespace right after @ means it's not mentioning anyone
        if query.first?.isWhitespace == true { return nil }
        return query.contains("\n") || query.hasSuffix(" ") ? nil : query
    }
    /// A draft has no conversation type yet; derive it from the member count
    private var isGroupChat: Bool { conversation.map { !$0.isDirect } ?? (memberIds.count > 1) }
    private var mentionMembers: [(id: String, name: String)] {
        let members = conversation?.members.map { ($0.userId, displayName(forMember: $0, agent: app.agent($0.userId))) }
            ?? memberIds.map { id in (id, app.agent(id).map { displayName(for: $0) } ?? id) }
        return members.filter { $0.0 != app.user?.userId }.map { member in
            let duplicates = members.filter { $0.1 == member.1 }
            guard duplicates.count > 1 else { return (id: member.0, name: member.1) }
            let computer = app.agent(member.0)?.computerName ?? ""
            let label = computer.isEmpty ? member.1 : "\(member.1) (\(computer))"
            let sameComputer = duplicates.filter { (app.agent($0.0)?.computerName ?? "") == computer }
            let suffix = sameComputer.count > 1 ? " #\((sameComputer.firstIndex { $0.0 == member.0 } ?? 0) + 1)" : ""
            return (id: member.0, name: label + suffix)
        }
    }
    /// Other real people. @all people expands to them on send
    private var mentionPeople: [String] {
        let others = conversation?.members.filter { !$0.isAgent }.map(\.userId)
            ?? memberIds.filter { app.agent($0)?.isAgent != true }
        return others.filter { $0 != app.user?.userId }
    }
    private var mentionMatches: [(id: String, name: String)] {
        guard let query = mentionQuery else { return [] }
        // A direct chat has just one person, so "all people" isn't needed
        let everyone = mentionMembers.count > 1 && !mentionPeople.isEmpty
            ? [(id: allPeopleMention, name: L10n.string("mention.allPeople"))] : []
        return (everyone + mentionMembers).filter { query.isEmpty || $0.name.localizedCaseInsensitiveContains(query) }
    }
    private var mentionJumpTarget: RemoteMessage? {
        guard let seq = mentionJumpSeq else { return nil }
        return chat.visibleMessages.first { $0.seq == seq }
    }
    private func flash(_ messageId: String) {
        flashedMessageId = messageId
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            withAnimation { if flashedMessageId == messageId { flashedMessageId = nil } }
        }
    }
    /// @-mentions to highlight in the body: userId isn't in the body, so match by name; old messages with renamed users are left as is
    private func mentionHighlights(for message: RemoteMessage) -> [MentionHighlight] {
        guard let mentions = message.mentions, !mentions.isEmpty else { return [] }
        let names = mentions.compactMap { id -> MentionHighlight? in
            let name = conversation?.members.first { $0.userId == id }.map { displayName(forMember: $0, agent: app.agent(id)) }
            return name.map { MentionHighlight(label: $0, mine: id == app.user?.userId) }
        }
        let forMe = mentions.contains(app.user?.userId ?? "")
        return names + allPeopleLabels.map { MentionHighlight(label: $0, mine: forMe) }
    }
    /// Long-press a name on a group message: @ that person. The composer cursor position isn't available, so append at the end; people who left can't be @-mentioned
    private func mention(_ userId: String) {
        guard let member = mentionMembers.first(where: { $0.id == userId }) else { return }
        pickedMentions[member.name] = member.id
        text += "@\(member.name) "
        composing = true
    }
    /// Reply: show the quote above the composer; for others' messages in group chats, auto-@ the sender at the start, unless already mentioned
    private func startReply(_ message: RemoteMessage) {
        guard !readOnly else { return }
        cancelReply()
        let member = isGroupChat ? mentionMembers.first { $0.id == message.senderId } : nil
        let label = member.flatMap { text.contains("@\($0.name)") ? nil : $0.name }
        if let member, let label {
            pickedMentions[label] = member.id
            text = "@\(label) " + text
        }
        replying = ReplyTarget(messageId: message.messageId, mentionLabel: label,
                               quote: MessageQuote(senderId: message.senderId, text: quotePreview(message)))
        composing = true
    }
    /// On cancel, also remove the auto-added @
    private func cancelReply() {
        if let label = replying?.mentionLabel, text.hasPrefix("@\(label) ") { text.removeFirst(label.count + 2) }
        replying = nil
    }
    private func quotePreview(_ message: RemoteMessage) -> String {
        let content = message.content.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if !content.isEmpty { return String(content.prefix(200)) }
        guard let first = message.attachments?.first else { return "" }
        if first.isImage { return L10n.string("attachment.preview.image") }
        if first.isVideo { return L10n.string("attachment.preview.video") }
        return L10n.format("attachment.preview.file %@", first.name)
    }
    /// Only mentions picked from the menu count: userId is bound on selection, manually typed text isn't parsed. Deleted from the body means no longer counted
    private var selectedMentions: [String] {
        let memberIds = Set(mentionMembers.map(\.id)).union([allPeopleMention])
        var seen = Set<String>()
        return resolveMentions(in: text, options: pickedMentions.filter { memberIds.contains($0.value) })
            .flatMap { $0 == allPeopleMention ? mentionPeople : [$0] }
            .filter { seen.insert($0).inserted }
    }

    /// A shared Agent I'm using was paused by its owner: no more messages can be sent; only the owner can resume
    private var pausedByOwner: (owner: String, agent: String)? {
        guard let member = conversation?.members.first(where: { $0.ownerPaused == true && app.agent($0.userId)?.owner != app.user?.userId }) else { return nil }
        let ownerId = app.agent(member.userId)?.owner
        let owner = app.friends.first { $0.userId == ownerId }.map { displayName(for: $0) } ?? ownerId ?? ""
        return (owner, displayName(forMember: member, agent: app.agent(member.userId)))
    }

    /// When using someone else's shared Agent, its owner can also see this conversation
    private var shareOwnerNames: String {
        let ids = conversation?.members.map(\.userId) ?? memberIds
        let owners = ids.compactMap { app.agent($0)?.owner }.filter { $0 != app.user?.userId && !ids.contains($0) }
        return Set(owners).sorted().compactMap { owner in app.friends.first { $0.userId == owner }.map { displayName(for: $0) } }.joined(separator: "、")
    }

    private var composer: some View {
        VStack(spacing: 0) {
            if let pausedByOwner {
                Text("chat.shareOwnerPaused \(pausedByOwner.owner) \(pausedByOwner.agent)")
                    .font(.caption).foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 6)
            }
            if !shareOwnerNames.isEmpty {
                Text("chat.shareOwnerNotice \(shareOwnerNames)")
                    .font(.caption).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16).padding(.vertical, 6)
            }
            if !mentionMatches.isEmpty {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(mentionMatches, id: \.id) { member in
                            Button {
                                guard let at = text.lastIndex(of: "@") else { return }
                                pickedMentions[member.name] = member.id
                                text.replaceSubrange(at..., with: "@\(member.name) ")
                                composing = true
                            } label: {
                                HStack(spacing: 10) {
                                    if member.id == allPeopleMention {
                                        Image(systemName: "person.2.fill").frame(width: 30, height: 30).foregroundStyle(.secondary)
                                    } else {
                                        AvatarView(name: member.name, kind: app.agent(member.id)?.agentKind, size: 30)
                                    }
                                    Text(member.name).foregroundStyle(.primary)
                                    Spacer()
                                }
                                .padding(.horizontal, 16).padding(.vertical, 10)
                                .contentShape(Rectangle())
                            }.buttonStyle(.plain)
                            Divider().padding(.leading, 56)
                        }
                    }
                }
                .frame(height: min(CGFloat(mentionMatches.count) * 51, 200))
                .background(Color(.secondarySystemBackground))
                .accessibilityLabel(Text("chat.mention.choose"))
            }
            if let replying {
                HStack(spacing: 8) {
                    Rectangle().fill(Color.secondary.opacity(0.4)).frame(width: 3)
                    (Text(name(of: replying.quote.senderId)).fontWeight(.semibold) + Text("  " + replying.quote.text))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Button { cancelReply() } label: {
                        Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                    }
                    .accessibilityLabel(Text("chat.reply.cancel"))
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16).padding(.vertical, 6)
            }
            if !pending.isEmpty {
                PendingAttachmentsBar(attachments: pending) { removed in
                    removed.discard()
                    pending.removeAll { $0.id == removed.id }
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(placeholder, text: $text, axis: .vertical)
                    .onChange(of: text) { _, current in
                        pickedMentions = pickedMentions.filter { current.contains("@\($0.key)") }
                    }
                    .lineLimit(1...6)
                    .focused($composing)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemBackground)))
                // The attachment + sits with the send button, both on the right-hand side
                HStack(spacing: 4) {
                    attachMenu
                    Button {
                        let content = text
                        let mentions = selectedMentions
                        let attachments = pending
                        let reply = replying
                        Task {
                            if await chat.send(content, attachments: attachments, mentions: mentions,
                                               replyTo: reply?.messageId, quote: reply?.quote, createConversation: createFromDraft) {
                                text = ""
                                pickedMentions = [:]
                                replying = nil
                                pending = []
                            }
                        }
                    } label: {
                        Group {
                            // With attachments, upload first; the spinner means still uploading
                            if chat.sending && !pending.isEmpty {
                                ProgressView().tint(.white)
                            } else {
                                Image(systemName: "paperplane.fill")
                                    .font(.system(size: 17, weight: .semibold))
                            }
                        }
                        .foregroundStyle(.white)
                        .frame(width: 36, height: 36)
                        .background(Circle().fill(canSend || chat.sending ? Color.accentColor : Color.gray.opacity(0.4)))
                    }
                    .disabled(!canSend)
                    .accessibilityLabel(Text("chat.send"))
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(.bar)
    }

    private func openCamera() {
        composing = false
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            chat.error = L10n.string("chat.camera.unavailable")
            return
        }
        Task { @MainActor in
            let allowed: Bool
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: allowed = true
            case .notDetermined: allowed = await AVCaptureDevice.requestAccess(for: .video)
            default: allowed = false
            }
            if allowed {
                takingPhoto = true
            } else {
                chat.error = L10n.string("chat.camera.denied")
            }
        }
    }

    /// Copy selected photos/files into pending attachments; drop those beyond 9 and show a notice
    private func prepare<Item>(_ items: [Item], load: @escaping (Item) async throws -> LocalAttachment) {
        preparing = true
        Task {
            defer { preparing = false }
            var problems: [String] = []
            for item in items {
                guard pending.count < LocalAttachment.maxCount else {
                    problems.append(L10n.string("attachment.tooMany"))
                    break
                }
                do {
                    pending.append(try await load(item))
                } catch {
                    problems.append(error.localizedDescription)
                }
            }
            chat.error = problems.isEmpty ? nil : problems.joined(separator: "\n")
        }
    }

    private func createFromDraft(_ opening: String) async throws -> String {
        guard let draft else { throw APIError.rejected(code: "NO_DRAFT", message: L10n.string("error.emptyResponse")) }
        let created = try await app.createConversation(from: draft, opening: opening)
        conversation = created
        self.draft = nil
        return created.conversationId
    }

    private var ownsSharedAgent: Bool {
        readOnly && agents.contains { $0.owner == me }
    }

    private var ownerPaused: Bool {
        conversation?.members.contains { $0.ownerPaused == true && app.agent($0.userId)?.owner == me } == true
    }

    private func changeOwnerPause() {
        guard ownsSharedAgent, let id = chat.conversationId, !ownerControlPending else { return }
        ownerControlPending = true
        Task {
            defer { ownerControlPending = false }
            do {
                try await APIClient.shared.setOwnerPaused(id, paused: !ownerPaused)
                await app.refreshConversations()
                conversation = try await APIClient.shared.conversation(id)
            } catch { chat.error = error.localizedDescription }
        }
    }

    private var readOnly: Bool {
        guard let conversation else { return false }
        return conversation.isShared || !conversation.members.contains { $0.userId == me }
    }

    private var canSend: Bool {
        !readOnly && pausedByOwner == nil && !chat.sending && !preparing && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pending.isEmpty)
    }

    private func sender(of message: RemoteMessage) -> (name: String, kind: AgentKind?) {
        if let agent = app.agent(message.senderId), agent.isAgent { return (displayName(for: agent), agent.agentKind) }
        if let member = conversation?.members.first(where: { $0.userId == message.senderId }) {
            return (member.displayName ?? member.userId, nil)
        }
        if let friend = app.agent(message.senderId) { return (friend.displayName, nil) }
        return (message.senderId, nil)
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        guard let target = chat.visibleMessages.last?.messageId else { return }
        withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(target, anchor: .bottom) }
    }
}

private struct ReplyTarget {
    let messageId: String
    /// The @ auto-added at the start when replying; removed together when the reply is cancelled
    let mentionLabel: String?
    let quote: MessageQuote
}

struct MentionHighlight {
    let label: String
    let mine: Bool
}

/// Placeholder userId for "@all people" in the composer, expanded on send; neither the backend nor the scheduler knows it
private let allPeopleMention = "__all_people__"
/// Both Chinese and English spellings must be recognized: a message is in the language it was sent in, and the reader may use the other
private let allPeopleLabels = ["所有真人", "all people"]

private struct MessageRow: View {
    let message: RemoteMessage
    let mine: Bool
    let sender: (name: String, kind: AgentKind?)
    let mentions: [MentionHighlight]
    let onAvatar: () -> Void
    /// Direct chats don't use @, so this action doesn't exist there
    let onMention: (() -> Void)?
    let quoteSender: String?
    let onReply: () -> Void
    let onQuote: () -> Void

    var body: some View {
        if message.type == "SYSTEM" {
            VStack(spacing: 3) {
                Text(message.content)
                    .font(.caption)
                timestamp
            }
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
        } else if mine {
            HStack {
                Spacer(minLength: 48)
                VStack(alignment: .trailing, spacing: 6) {
                    if hasText {
                        bubble.background(RoundedRectangle(cornerRadius: 16).fill(Color.accentColor))
                            .foregroundStyle(.white)
                    }
                    attachments
                    timestamp
                }
            }
        } else {
            HStack(alignment: .top, spacing: 8) {
                AvatarView(name: sender.name, kind: sender.kind, size: 32)
                    .contentShape(Circle())
                    .onTapGesture(perform: onAvatar)
                    .accessibilityAddTraits(.isButton)
                    .accessibilityLabel(Text("member.profile.open \(sender.name)"))
                VStack(alignment: .leading, spacing: 3) {
                    Text(sender.name).font(.caption).foregroundStyle(.secondary)
                        .onLongPressGesture { onMention?() }
                        .accessibilityAction(named: Text("chat.mention.sender")) { onMention?() }
                    if hasText {
                        bubble.background(RoundedRectangle(cornerRadius: 16).fill(Color(.secondarySystemBackground)))
                            .overlay(alignment: .topTrailing) {
                                if message.failed == true {
                                    Image(systemName: "exclamationmark.circle.fill").foregroundStyle(.red).offset(x: 6, y: -6)
                                }
                            }
                    }
                    attachments
                    timestamp
                }
                Spacer(minLength: 32)
            }
        }
    }

    /// When only images/files were sent, don't leave an empty bubble
    private var hasText: Bool {
        !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || (message.attachments ?? []).isEmpty
            || message.extra?.quote != nil
    }

    @ViewBuilder private var timestamp: some View {
        if let at = message.gmtCreated {
            Text(L10n.time(at))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder private var attachments: some View {
        if let list = message.attachments, !list.isEmpty {
            MessageAttachmentsView(conversationId: message.conversationId, attachments: list, mine: mine)
                .contextMenu { messageActions }
        }
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let quote = message.extra?.quote {
                Button(action: onQuote) {
                    HStack(spacing: 6) {
                        Rectangle().fill(mine ? Color.white.opacity(0.6) : Color.secondary.opacity(0.4)).frame(width: 3)
                        (Text(quoteSender ?? "").fontWeight(.semibold) + Text("  " + quote.text))
                            .font(.footnote)
                            .foregroundStyle(mine ? Color.white.opacity(0.85) : Color.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .buttonStyle(.plain)
            }
            let text = MessageText.previewBody(rendered)
            if MessageMathContent.containsFormula(message.content) {
                MessageMathView(content: message.content, mine: mine, mentions: mentions)
            } else if !String(text.characters).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                Text(text)
                    .font(.body)
                    .tint(mine ? .white : .accentColor)
                    .lineLimit(nil)
                    .fixedSize(horizontal: false, vertical: true)
            }
            linkPreviews
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        // The long-press menu and text selection compete for the same gesture, so Copy goes into the menu
        .contextMenu { messageActions }
    }

    @ViewBuilder private var messageActions: some View {
        if message.failed != true {
            Button(action: onReply) { Label("chat.reply", systemImage: "arrowshape.turn.up.left") }
        }
        if !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            Button { UIPasteboard.general.string = message.content } label: { Label("chat.copy", systemImage: "doc.on.doc") }
        }
    }

    private var linkPreviews: some View {
        VStack(alignment: mine ? .trailing : .leading, spacing: 6) {
            ForEach(MessageText.webURLs(in: rendered), id: \.self) { url in
                MessageLinkPreview(url: url)
            }
        }
    }

    /// Agent replies are mostly Markdown: inline formatting (bold, code, links) is rendered and line breaks are kept
    private var rendered: AttributedString {
        var text = MessageText.attributed(message.content)
        for mention in mentions {
            var cursor = text.startIndex
            while cursor < text.endIndex, let range = text[cursor...].range(of: "@\(mention.label)") {
                if mine {
                    // My own bubble has the theme-blue background: text color follows the bubble's white and only bold distinguishes it, otherwise blue text blends into the background
                    text[range].font = .body.weight(.semibold)
                } else if mention.mine {
                    text[range].foregroundColor = .red
                    text[range].font = .body.weight(.semibold)
                } else {
                    text[range].foregroundColor = .accentColor
                }
                cursor = range.upperBound
            }
        }
        return text
    }
}

private struct OfflineBanner: View {
    let agent: RemoteUser

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "desktopcomputer.trianglebadge.exclamationmark")
            Text("chat.offline \(agent.computerName ?? L10n.string("computer.generic"))")
                .font(.footnote)
            Spacer()
        }
        .foregroundStyle(.orange)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.orange.opacity(0.1))
    }
}

/// Chat page shell: "Switch task"/"New task" replace it with another conversation in place instead of stacking deeper in the navigation stack
struct ChatScreen: View {
    @State private var route: ChatRoute
    /// Each conversation switch gets a new identity so the chat page is fully rebuilt (a new draft with the same members from a draft has the same route and must also rebuild)
    @State private var generation = UUID()

    init(route: ChatRoute) {
        _route = State(initialValue: route)
    }

    var body: some View {
        ChatView(route: route) { next in
            route = next
            generation = UUID()
        }
        .id(generation)
    }
}

/// "Add member": like the desktop header's add-member menu, searchable, agents on top, people below, tap + to add
private struct AddMembersSheet: View {
    let candidates: [RemoteUser]
    let add: (RemoteUser) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var adding: String?

    private var matched: [RemoteUser] {
        let query = search.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return candidates }
        return candidates.filter {
            displayName(for: $0).localizedCaseInsensitiveContains(query)
                || ($0.username ?? "").localizedCaseInsensitiveContains(query)
        }
    }

    var body: some View {
        NavigationStack {
            List {
                let agents = matched.filter(\.isAgent)
                let people = matched.filter { !$0.isAgent }
                if !agents.isEmpty {
                    Section("contacts.agents") { ForEach(agents) { row($0) } }
                }
                if !people.isEmpty {
                    Section("contacts.people") { ForEach(people) { row($0) } }
                }
            }
            .overlay {
                if matched.isEmpty {
                    ContentUnavailableView(search.isEmpty ? "chat.addMembers.none" : "chat.addMembers.noMatch",
                                           systemImage: "person.2")
                }
            }
            .searchable(text: $search, prompt: Text("chat.addMembers.search"))
            .navigationTitle(L10n.string("chat.addMembers"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("chat.addMembers.done") { dismiss() }
                }
            }
        }
    }

    private func row(_ user: RemoteUser) -> some View {
        HStack(spacing: 12) {
            AvatarView(name: displayName(for: user), kind: user.isAgent ? user.agentKind : nil, size: 36)
            VStack(alignment: .leading, spacing: 3) {
                Text(displayName(for: user)).font(.body.weight(.medium))
                if user.isAgent { ComputerStatusView(agent: user) }
            }
            Spacer()
            Button {
                adding = user.userId
                Task {
                    await add(user)
                    adding = nil
                }
            } label: {
                if adding == user.userId {
                    ProgressView()
                } else {
                    Image(systemName: "plus.circle").font(.title2)
                }
            }
            .buttonStyle(.borderless)
            .disabled(adding != nil)
            .accessibilityLabel(Text("chat.addMembers.add \(displayName(for: user))"))
        }
    }
}

/// Resolve @-mentions in the body to userIds. Each @ maps to only one member: the longest matching name wins,
/// so with both "Qoder" and "Qoder CN", @Qoder CN isn't also counted as @Qoder.
func resolveMentions(in text: String, options: [String: String]) -> [String] {
    let labels = options.keys.sorted { $0.count > $1.count }
    var found: [String] = []
    var cursor = text.startIndex
    while let at = text[cursor...].firstIndex(of: "@") {
        let rest = text[text.index(after: at)...]
        cursor = rest.startIndex
        let match = labels.first { label in
            guard rest.hasPrefix(label) else { return false }
            guard let after = rest.dropFirst(label.count).first else { return true }
            return after.isWhitespace || ",，。!！?？:：".contains(after)
        }
        guard let match, let id = options[match] else { continue }
        if !found.contains(id) { found.append(id) }
        cursor = rest.index(rest.startIndex, offsetBy: match.count)
    }
    return found
}
