import Foundation
import Observation
import UIKit

/// Global state: login state, friends (including whether the agent's computer is online), task list.
@MainActor
@Observable
final class AppModel {
    var user: StoredUser? = Credentials.user
    var friends: [RemoteUser] = []
    var agentShares: [String: [String]] = [:]
    var conversations: [RemoteConversation] = []
    private var refreshState = RefreshState()
    private let conversationsRefresh = CoalescedRefresh()
    var loadError: String? { refreshState.error }
    /// Agents currently working (which agent in which task); polled while the chat page is open
    var activity: Set<AgentActivity> = []

    @ObservationIgnored private let mqtt = MqttConnection()
    @ObservationIgnored private var mqttEnabled = false
    @ObservationIgnored private var activityState = MqttActivityState()
    @ObservationIgnored private var activityExpiry: Task<Void, Never>?

    var isSignedIn: Bool { user != nil }

    init() {
        let scope = FeedbackDiagnostics.Scope(owner: Credentials.user?.userId, environment: ServerEnvironment.current.rawValue)
        Task { await FeedbackDiagnostics.shared.record("app-start", fields: ["version": AppVersion.display], scope: scope) }
        mqtt.onModeChanged = { [weak self] enabled in self?.mqttEnabled = enabled }
        mqtt.onFrame = { [weak self] frame in self?.receive(frame) }
        mqtt.onConnected = { [weak self] in
            let scope = FeedbackDiagnostics.Scope(owner: Credentials.user?.userId, environment: ServerEnvironment.current.rawValue)
            Task { await FeedbackDiagnostics.shared.record("mqtt-connected", scope: scope) }
            Task { await self?.refresh() }
            NotificationCenter.default.post(name: .mqttConversationChanged, object: nil)
        }
        mqtt.onDisconnected = { [weak self] in
            let scope = FeedbackDiagnostics.Scope(owner: Credentials.user?.userId, environment: ServerEnvironment.current.rawValue)
            Task { await FeedbackDiagnostics.shared.record("mqtt-disconnected", scope: scope) }
            self?.activityState.disconnect(); self?.activity = []
        }
        let client = APIClient.shared
        Task { [weak self] in
            await client.setUnauthorizedHandler { [weak self] in
                Task { @MainActor in self?.signOutLocally() }
            }
        }
    }

    func signIn(username: String, password: String) async throws {
        let tokens = try await APIClient.shared.login(username: username, password: password)
        user = StoredUser(userId: tokens.user.userId, username: tokens.user.username ?? username, displayName: tokens.user.displayName)
        await refresh()
        setForeground(true)
    }

    func signOut() {
        Credentials.clear()
        signOutLocally()
    }

    private func signOutLocally() {
        setForeground(false)
        PushNotifications.shared.signedOut()
        mqttEnabled = false
        activityState.reset()
        user = nil
        friends = []
        agentShares = [:]
        conversations = []
        activity = []
        conversationsRefresh.cancel()
        refreshState.reset()
    }

    func refresh() async {
        guard isSignedIn else { return }
        async let agents: Void = refreshAgents()
        async let tasks: Void = refreshConversations()
        _ = await (agents, tasks)
    }

    func refreshConversations() async {
        guard isSignedIn else { return }
        await conversationsRefresh.run { [weak self] in await self?.loadConversations() }
    }

    private func loadConversations() async {
        guard isSignedIn else { return }
        let request = refreshState.begin(.conversations)
        do {
            let list = try await APIClient.shared.conversations()
            try Task.checkCancellation()
            guard refreshState.finish(.conversations, request: request) else { return }
            conversations = list.sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
            updateBadge()
        } catch {
            _ = refreshState.finish(.conversations, request: request, error: error)
        }
    }

    private func updateBadge() {
        PushNotifications.shared.setBadge(conversations.reduce(0) { $0 + ($1.unreadCount ?? 0) })
    }

    /// Report the push token and current language; report again when the language changes
    func syncPush() {
        guard let userId = user?.userId else { return }
        let name = terminalName
        Task { await PushNotifications.shared.sync(userId: userId, deviceName: name) }
    }

    /// Tapping a contact (agent or person): the most recently active direct chat with them; returns nil if there is none, and the chat page opens a draft first
    func directConversation(with userId: String) -> RemoteConversation? {
        conversations.first { !$0.isShared && $0.isDirect && $0.members.contains { $0.userId == userId } }
    }

    /// Unread count on a contact: sum of unread across all active direct chats with them (same as desktop)
    func unreadCount(with userId: String) -> Int {
        conversations.filter { $0.isDirect && ($0.status ?? "ACTIVE") == "ACTIVE" && $0.members.contains { $0.userId == userId } }
            .reduce(0) { $0 + ($1.unreadCount ?? 0) }
    }

    /// A task is only actually created when the draft sends its first message; no empty tasks are left behind (same as desktop).
    /// With an agent: the name is a placeholder until the leader (the other party in a direct chat) names it from the first message; people only: nobody names it, so the first message is used as the name.
    /// Roles match desktop: with agents, the leader is the selected agent and the rest are ENGINEER; for people-only group tasks, the user is the leader.
    func createConversation(from draft: ConversationDraft, opening: String) async throws -> RemoteConversation {
        let hasAgent = draft.memberIds.contains { agent($0)?.isAgent == true }
        let group = draft.memberIds.count > 1
        var members = draft.memberIds.map {
            CreateConversationRequest.Member(userId: $0, role: group && $0 == draft.leaderId ? "LEADER" : "ENGINEER")
        }
        if let me = user?.userId {
            members.insert(.init(userId: me, role: group && !hasAgent ? "LEADER" : "ENGINEER"), at: 0)
        }
        let name = hasAgent ? "新会话" : String(opening.replacingOccurrences(of: "\n", with: " ").prefix(30))
        let created = try await APIClient.shared.createConversation(members: members, name: name, autoTitle: hasAgent, permanent: draft.permanent)
        conversations.insert(created, at: 0)
        return created
    }

    func refreshActivity() async {
        if mqttEnabled { expireActivity(); return }
        guard isSignedIn, let list = try? await APIClient.shared.agentActivity() else { return }
        activity = Set(list)
    }

    func setForeground(_ active: Bool) {
        if active && isSignedIn {
            mqtt.start(deviceName: terminalName)
            syncPush()
            if activityExpiry == nil {
                activityExpiry = Task { [weak self] in
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(1)) } catch { return }
                        self?.expireActivity()
                    }
                }
            }
        } else {
            mqtt.stop()
            activityExpiry?.cancel(); activityExpiry = nil
            activity = []
        }
    }

    /// Name reported to the server when registering the terminal; see `AppRules.terminalName`
    private var terminalName: String {
        AppRules.terminalName(deviceName: UIDevice.current.name, model: UIDevice.current.model,
                              owner: user?.displayName ?? user?.username ?? "") {
            L10n.format("terminal.name %@ %@", $0, $1)
        }
    }

    private func expireActivity() {
        guard mqttEnabled else { return }
        activity = Set(activityState.snapshot().map {
            AgentActivity(conversationId: $0.conversationId, agentUserId: $0.agentUserId, lines: $0.lines)
        })
    }

    private func receive(_ frame: MqttFrame) {
        switch frame.type {
        case "TURN_PROGRESS":
            guard let body = frame.payload, let conversationId = body.conversationId, let agentId = body.agentUserId else { return }
            activityState.apply(conversationId: conversationId, agentUserId: agentId,
                                busy: body.busy, text: body.text, sequence: body.sentAt)
            expireActivity()
        case "MESSAGE_NEW", "CONVERSATION_UPDATED":
            Task { await refreshConversations() }
            NotificationCenter.default.post(name: .mqttConversationChanged, object: frame.payload?.conversationId)
        case "AGENTS_CHANGED", "AGENT_UPDATED", "FRIENDS_CHANGED":
            Task { await refreshAgents() }
        default: break
        }
    }

    func refreshAgents() async {
        guard isSignedIn else { return }
        async let contacts: Void = refreshFriends()
        async let shares: Void = refreshAgentShares()
        _ = await (contacts, shares)
    }

    private func refreshFriends() async {
        guard isSignedIn else { return }
        let request = refreshState.begin(.friends)
        do {
            let list = try await APIClient.shared.friends()
            try Task.checkCancellation()
            guard refreshState.finish(.friends, request: request) else { return }
            friends = list
        } catch {
            _ = refreshState.finish(.friends, request: request, error: error)
        }
    }

    private func refreshAgentShares() async {
        guard isSignedIn else { return }
        let request = refreshState.begin(.shares)
        do {
            let shares = try await APIClient.shared.agentShares()
            try Task.checkCancellation()
            guard refreshState.finish(.shares, request: request) else { return }
            agentShares = shares
        } catch {
            // This optional lookup was already silent; cancellation must not erase cached shares.
            if RequestCancellation.isCancellation(error) {
                _ = refreshState.finish(.shares, request: request, error: error)
            } else if refreshState.finish(.shares, request: request) {
                agentShares = [:]
            }
        }
    }

    /// An agent in the task is working
    func isBusy(_ conversationId: String) -> Bool {
        activity.contains { $0.conversationId == conversationId }
    }

    /// In the contact list: whether this agent is working in any conversation
    func isBusy(agentUserId: String) -> Bool {
        activity.contains { $0.agentUserId == agentUserId }
    }

    private var agentOwners: [String: String] {
        Dictionary(uniqueKeysWithValues: friends.filter(\.isAgent).compactMap { agent in agent.owner.map { (agent.userId, $0) } })
    }

    func withAgentOwners(_ memberIds: [String]) -> [String] {
        AppRules.withAgentOwners(memberIds, currentUser: user?.userId, owners: agentOwners)
    }

    func canJoinTogether(_ memberIds: [String]) -> Bool {
        AppRules.canJoin(memberIds, currentUser: user?.userId, owners: agentOwners, shares: agentShares)
    }

    func agent(_ userId: String) -> RemoteUser? {
        friends.first { $0.userId == userId }
    }

    /// Friend records for the agents in the task (with computer online status)
    func agents(in conversation: RemoteConversation) -> [RemoteUser] {
        conversation.agentMembers.compactMap { agent($0.userId) }
    }

    /// The other party in a direct chat
    func counterpart(in conversation: RemoteConversation) -> RemoteMember? {
        conversation.members.first { $0.userId != user?.userId }
    }
}

extension APIClient {
    func setUnauthorizedHandler(_ handler: @escaping @Sendable () -> Void) {
        onUnauthorized = handler
    }
}

/// A task not yet created: the chosen members (excluding self) and the leader. Tapping a contact or creating a task both start as a draft
struct ConversationDraft: Hashable {
    let memberIds: [String]
    var leaderId: String?
    var permanent = false
}

/// The chat page shows either an existing task or a draft
enum ChatRoute: Hashable {
    case conversation(RemoteConversation)
    case draft(ConversationDraft)
}

extension RemoteConversation {
    var lastActivity: Date? { lastMessage?.gmtCreated ?? gmtModified ?? gmtCreated }
}

extension Notification.Name {
    static let mqttConversationChanged = Notification.Name("ading.mqtt.conversationChanged")
}
