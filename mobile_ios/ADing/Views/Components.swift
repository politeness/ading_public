import SwiftUI

/// Chinese when the UI language is Chinese, otherwise English (only these two, same as desktop)
/// Check "Settings → Language" first: if Chinese or English is chosen in the App, use it; only when following the system, use the language the system assigned to the App.
/// Looking only at the system language, with the system in Chinese and English chosen in the App, the UI text is English but the Agent would still be called "小c".
enum UILanguage {
    static var isChinese: Bool {
        switch AppLanguage.saved {
        case .zh: true
        case .en: false
        case .system: (Bundle.main.preferredLocalizations.first ?? "en").hasPrefix("zh")
        }
    }
}

/// Agent name: if it's still the default Chinese name registered by desktop, show the matching English name in the English UI; user-renamed names are shown as is
func displayName(for user: RemoteUser) -> String {
    guard let kind = user.agentKind, !UILanguage.isChinese, user.displayName == kind.defaultNames.zh else {
        return user.displayName
    }
    return kind.defaultNames.en
}

func displayName(forMember member: RemoteMember, agent: RemoteUser?) -> String {
    if let agent { return displayName(for: agent) }
    return member.displayName ?? member.userId
}

/// Placeholder names from desktop quick-create are shown in the current language; unnamed direct chats show the other party's name
func displayTitle(for conversation: RemoteConversation, counterpartName: String?) -> String {
    if ["新会话", "新任务"].contains(conversation.name) {
        if let counterpartName, conversation.isDirect { return counterpartName }
        return L10n.string("conversation.draftName")
    }
    return conversation.name
}

/// Avatars: agents use their vendor's icon, always on white (icons may have transparent areas); people use the first character of their name
struct AvatarView: View {
    let name: String
    let kind: AgentKind?
    var size: CGFloat = 40

    var body: some View {
        ZStack {
            if let kind {
                Circle().fill(Color.white)
                Image(kind.iconName)
                    .resizable()
                    .scaledToFit()
                    .padding(size * 0.14)
                    .clipShape(Circle())
            } else {
                Circle().fill(Color.accentColor.opacity(0.15))
                Text(String(name.prefix(1)))
                    .font(.system(size: size * 0.42, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .frame(width: size, height: size)
        .overlay(Circle().stroke(Color.black.opacity(0.08), lineWidth: 0.5))
        .accessibilityLabel(name)
    }
}

/// Agent traffic light, same rules as desktop: green only when its computer is online and ready;
/// computer offline, quota exhausted, not logged in, not installed, or error are red; never reported yet is orange "Checking"
struct AgentSignal {
    enum Lamp { case green, red, orange }
    let lamp: Lamp
    /// The word beside the light; empty when ready
    let text: String

    init(agent: RemoteUser) {
        if agent.computerOnline != true {
            (lamp, text) = (.red, L10n.string("agent.computerOffline"))
            return
        }
        switch agent.readiness {
        case "ready": (lamp, text) = (.green, "")
        case "exhausted": (lamp, text) = (.red, L10n.string("agent.exhausted"))
        case "unauthorized": (lamp, text) = (.red, L10n.string("agent.signedOut"))
        case "missing": (lamp, text) = (.red, L10n.string("agent.notInstalled"))
        case "error": (lamp, text) = (.red, L10n.string("agent.stateError"))
        default: (lamp, text) = (.orange, L10n.string("agent.checking"))
        }
    }

    var available: Bool { lamp == .green }

    var color: Color {
        switch lamp {
        case .green: .green
        case .red: .red
        case .orange: .orange
        }
    }
}

/// Light + status word. Phones have no hover, so the computer name is written alongside (it distinguishes same-named agents)
struct ComputerStatusView: View {
    let agent: RemoteUser

    var body: some View {
        let signal = AgentSignal(agent: agent)
        HStack(spacing: 4) {
            Circle()
                .fill(signal.color)
                .frame(width: 7, height: 7)
            Text(statusText(signal))
                .font(.caption)
                .foregroundStyle(signal.lamp == .red ? Color.red : Color.secondary)
                .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }

    private func statusText(_ signal: AgentSignal) -> String {
        let name = agent.computerName ?? ""
        if agent.computerOnline != true || name.isEmpty { return signal.text }
        return signal.text.isEmpty ? name : "\(name) · \(signal.text)"
    }
}

/// The "thinking" Ikkyu: shown beside the task title while an agent is working. Same 44-frame strip as desktop, 1.1 s per loop;
/// with the system's Reduce Motion on, show a still frame (desktop stops the animation too)
struct IkkyuThinking: View {
    var size: CGFloat = 22
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let frames = 44
    private static let period = 1.1

    var body: some View {
        Group {
            if reduceMotion {
                Image("ikkyu-idle").resizable().frame(width: size, height: size)
            } else {
                TimelineView(.periodic(from: .now, by: Self.period / Double(Self.frames))) { context in
                    let tick = context.date.timeIntervalSinceReferenceDate / (Self.period / Double(Self.frames))
                    let frame = Int(tick) % Self.frames
                    Image("ikkyu-strip")
                        .resizable()
                        .frame(width: size * CGFloat(Self.frames), height: size)
                        .offset(x: -CGFloat(frame) * size)
                        .frame(width: size, height: size, alignment: .leading)
                        .clipped()
                }
            }
        }
        .accessibilityElement()
        .accessibilityLabel(Text("chat.thinking"))
    }
}

/// Button floating over the message area: same look as desktop .message-filter-button (36 pt rounded square, white background, thin border, shadow)
struct FloatingButton<Icon: View>: View {
    let label: LocalizedStringKey
    let action: () -> Void
    @ViewBuilder let icon: () -> Icon

    var body: some View {
        Button(action: action) {
            icon()
                .frame(width: 23, height: 23)
                .foregroundStyle(Color(red: 0x69 / 255, green: 0x73 / 255, blue: 0x86 / 255))
                .frame(width: 36, height: 36)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color(.systemBackground).opacity(0.94)))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color(red: 220 / 255, green: 225 / 255, blue: 233 / 255).opacity(0.9), lineWidth: 1))
                .shadow(color: .black.opacity(0.12), radius: 10, y: 4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(label))
    }
}

/// Activity icon: drawn after desktop icons.ts activity (24×24 canvas: three lines, two small circles, line width 1.8)
struct ActivityIcon: View {
    var body: some View {
        Canvas { context, size in
            let scale = min(size.width, size.height) / 24
            var path = Path()
            path.move(to: CGPoint(x: 5, y: 7)); path.addLine(to: CGPoint(x: 13, y: 7))
            path.move(to: CGPoint(x: 5, y: 12)); path.addLine(to: CGPoint(x: 19, y: 12))
            path.move(to: CGPoint(x: 5, y: 17)); path.addLine(to: CGPoint(x: 15, y: 17))
            path.addEllipse(in: CGRect(x: 15, y: 5, width: 4, height: 4))
            path.addEllipse(in: CGRect(x: 16, y: 15, width: 4, height: 4))
            context.stroke(path.applying(CGAffineTransform(scaleX: scale, y: scale)), with: .foreground,
                           style: StrokeStyle(lineWidth: 1.8 * scale, lineCap: .round, lineJoin: .round))
        }
    }
}

/// Chat header avatar of the other side: the other person's avatar in direct chats; groups show a collage of up to 4 members (like desktop header .member-collage:
/// rounded square, light grey background, two side by side, three with the third centered on the bottom row, four in 2×2)
struct MemberCollage: View {
    let members: [(name: String, kind: AgentKind?)]
    var size: CGFloat = 30

    var body: some View {
        if members.count == 1, let only = members.first {
            AvatarView(name: only.name, kind: only.kind, size: size)
        } else {
            let shown = Array(members.prefix(4))
            let gap: CGFloat = 2
            let inset: CGFloat = 3
            let cell = (size - inset * 2 - gap) / 2
            VStack(spacing: gap) {
                HStack(spacing: gap) {
                    ForEach(0..<min(2, shown.count), id: \.self) { index in
                        AvatarView(name: shown[index].name, kind: shown[index].kind, size: cell)
                    }
                }
                if shown.count > 2 {
                    HStack(spacing: gap) {
                        ForEach(2..<shown.count, id: \.self) { index in
                            AvatarView(name: shown[index].name, kind: shown[index].kind, size: cell)
                        }
                    }
                }
            }
            .frame(width: size, height: size)
            .background(RoundedRectangle(cornerRadius: 7).fill(Color(red: 0xE8 / 255, green: 0xEB / 255, blue: 0xF0 / 255)))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(members.map(\.name).joined(separator: "、"))
        }
    }
}
