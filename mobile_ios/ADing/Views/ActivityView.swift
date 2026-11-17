import SwiftUI

/// Activity: same content as desktop, listing agents' execution by round.
///     - Finished rounds: execution steps carried in agent replies, plus internal scheduling messages (those desktop keeps out of chat);
///     - Running round: live progress reported by the computer to the server (the server keeps only the latest few dozen lines in memory).
/// The computer's local queue isn't uploaded to the cloud, so the phone has no such section.
struct ActivityView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    let conversationId: String
    let chat: ChatModel
    let name: (String) -> String

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(runs) { run in
                            RunCard(run: run, name: run.agentId.map(name) ?? L10n.string("process.system"),
                                    kind: run.agentId.flatMap { app.agent($0)?.agentKind })
                                .id(run.id)
                        }
                        Color.clear.frame(height: 1).id("activity-bottom")
                    }
                    .padding(12)
                }
                .overlay {
                    if runs.isEmpty {
                        ContentUnavailableView("process.empty", systemImage: "list.bullet.rectangle")
                    }
                }
                .task(id: scrollRevision) {
                    // Live run keeps the same ID while its lines grow. Wait for the
                    // updated card height before scrolling to the bottom sentinel.
                    await Task.yield()
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo("activity-bottom", anchor: .bottom)
                    }
                }
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("process.title")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("process.close") { dismiss() }
                }
            }
        }
    }

    private var runs: [ProcessRun] {
        var result: [ProcessRun] = []
        for message in chat.messages {
            let steps = message.extra?.steps ?? []
            let operational = message.isOperational
            guard !steps.isEmpty || operational else { continue }
            result.append(ProcessRun(
                id: "message:\(message.messageId)",
                agentId: message.senderId,
                state: message.failed == true ? .failed : .done,
                headline: operational ? message.content : L10n.string("process.done"),
                events: steps,
                at: message.gmtCreated))
        }
        for activity in app.activity where activity.conversationId == conversationId {
            let lines = activity.lines ?? []
            result.append(ProcessRun(
                id: "live:\(activity.agentUserId)",
                agentId: activity.agentUserId,
                state: .running,
                headline: lines.last ?? L10n.string("process.starting"),
                events: Array(lines.dropLast()),
                at: nil))
        }
        return result
    }

    private var scrollRevision: [String] {
        runs.map { run in
            "\(run.id):\(run.headline):\(run.events.count):\(run.events.last ?? "")"
        }
    }
}

struct ProcessRun: Identifiable {
    enum State { case running, done, failed }
    let id: String
    let agentId: String?
    let state: State
    let headline: String
    let events: [String]
    /// Reply time when this round ended; not yet available for a running round
    let at: Date?
}

private struct RunCard: View {
    let run: ProcessRun
    let name: String
    let kind: AgentKind?
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                AvatarView(name: name, kind: kind, size: 22)
                Text(name).font(.subheadline.weight(.medium))
                if let at = run.at {
                    Text(L10n.time(at))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(stateText)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(stateColor)
            }
            Text(run.headline)
                .font(.subheadline)
                .textSelection(.enabled)
            let hidden = run.events.dropLast(3)
            let visible = run.events.suffix(3)
            if !hidden.isEmpty {
                DisclosureGroup(isExpanded: $expanded) {
                    Timeline(events: Array(hidden))
                } label: {
                    Text("process.moreLogs \(hidden.count)").font(.caption)
                }
            }
            if !visible.isEmpty { Timeline(events: Array(visible)) }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color(.secondarySystemGroupedBackground)))
    }

    private var stateText: LocalizedStringKey {
        switch run.state {
        case .running: "process.running"
        case .failed: "process.failed"
        case .done: "process.done"
        }
    }

    private var stateColor: Color {
        switch run.state {
        case .running: .accentColor
        case .failed: .red
        case .done: .secondary
        }
    }
}

private struct Timeline: View {
    let events: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Circle().fill(Color.secondary.opacity(0.5)).frame(width: 5, height: 5)
                    Text(event)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
    }
}

extension RemoteMessage {
    /// Scheduling messages: those desktop shows only in Activity, not in chat (rules match desktop isOperationalMessage)
    var isOperational: Bool {
        if `internal` == true || failed == true { return true }
        if type == "SYSTEM", content.range(of: Self.operationalSystemPrefix, options: .regularExpression) != nil { return true }
        // The Leader's own receipt for taking on an assignment
        if type == "TASK", let c = extra?.coordination, c.phase == "accepted", senderId == c.assigneeId,
           extra?.hasAgentReply != true,
           content.range(of: #"^(?:Leader 开始承担(?:工作 |分工：)|The Leader is taking on (?:work |an assignment: ))"#, options: .regularExpression) != nil {
            return true
        }
        return false
    }

    private static let operationalSystemPrefix =
        #"^((?:任务|会话)未停止、尚未完成交付|(?:任务|会话)尚未停止，但已连续跟进|上条回复已保留。生成期间|(?:任务|会话)指示已更新。|The (?:task|conversation) hasn't stopped and hasn't been delivered|The (?:task|conversation) hasn't stopped, but \d+ follow-ups|The previous reply was kept\. New messages arrived|(?:Task|Conversation) instructions updated\.)"#
}
