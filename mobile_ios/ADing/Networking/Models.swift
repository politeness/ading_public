import Foundation

/// Uniform backend response wrapper: code is "OK" on success.
struct APIEnvelope<T: Decodable>: Decodable {
    let code: String
    let message: String?
    let data: T?
}

/// Placeholder for endpoints with no response body.
struct Empty: Codable {}

struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String
    let user: RemoteUser
}

/// A user or agent. Agents also carry their computer's name and online status (only filled in the friend list).
struct RemoteUser: Decodable, Identifiable, Hashable {
    let userId: String
    let username: String?
    let displayName: String
    let isAgent: Bool
    let status: String?
    let agentType: String?
    let agentVersion: String?
    let persona: String?
    let owner: String?
    let computerName: String?
    let computerOnline: Bool?
    /// The agent's readiness on its computer (ready / exhausted / unauthorized / missing / error), reported by that computer
    let readiness: String?

    var id: String { userId }

    var agentKind: AgentKind? { agentType.flatMap(AgentKind.init(cloudType:)) }
}

struct RemoteMember: Decodable, Hashable {
    let userId: String
    let displayName: String?
    let isAgent: Bool
    let role: String
    let lastReadSeq: Int
    /// The first unread message that @-mentions this person
    let firstUnreadMentionSeq: Int?
    let paused: Bool?
    let ownerPaused: Bool?
}

extension RemoteMember {
    var hasUnreadMention: Bool { (firstUnreadMentionSeq ?? 0) > lastReadSeq }
}

struct ConversationExtra: Codable, Hashable {
    let permanent: Bool?
}

struct RemoteConversation: Decodable, Identifiable, Hashable {
    let conversationId: String
    let name: String
    let type: String
    let owner: String?
    let lastSeq: Int
    let unreadCount: Int?
    let lastMessage: RemoteMessage?
    let members: [RemoteMember]
    let status: String?
    let paused: Bool?
    let autoTitle: Bool?
    var extra: ConversationExtra? = nil
    var permanent: Bool { extra?.permanent == true }
    var shared: Bool? = nil
    var isShared: Bool { shared == true }
    let gmtCreated: Date?
    let gmtModified: Date?

    var id: String { conversationId }
    var isDirect: Bool { type == "DIRECT" }
    var agentMembers: [RemoteMember] { members.filter(\.isAgent) }
}

struct RemoteMessage: Decodable, Identifiable, Hashable {
    let messageId: String
    let conversationId: String
    let seq: Int
    let senderId: String
    let content: String
    let type: String
    /// userIds that are @-mentioned
    let mentions: [String]?
    let replyTo: String?
    let status: String?
    let gmtCreated: Date?
    let `internal`: Bool?
    let report: Bool?
    let failed: Bool?
    /// Extra info written by the desktop scheduler: this round's execution steps etc., used by Activity
    let extra: MessageExtra?
    /// Images, videos, files. Metadata only; the download URL is requested from the server when needed
    let attachments: [RemoteAttachment]?

    var id: String { messageId }
}

/// An attachment in a message. The file is in OSS with a time-limited download URL, fetched on demand via APIClient.attachmentURL
struct RemoteAttachment: Codable, Hashable, Identifiable {
    let attachmentId: String
    let name: String
    let mimeType: String
    let size: Int64
    /// IMAGE / VIDEO / FILE
    let kind: String

    var id: String { attachmentId }
    var isImage: Bool { kind.uppercased() == "IMAGE" }
    var isVideo: Bool { kind.uppercased() == "VIDEO" }
}

/// Result of registering an attachment: PUT the file to uploadUrl; Content-Type must equal contentType
struct AttachmentTicket: Decodable {
    let attachment: RemoteAttachment
    let uploadUrl: String
    let contentType: String
    let uploaded: Bool
}

struct AttachmentURL: Decodable {
    let url: String
    let expiresAt: Date?
}

struct CreateAttachmentRequest: Encodable {
    let attachmentId: String
    let name: String
    let mimeType: String
    let size: Int64
}

/// Only the few fields of a message's extra that Activity needs; if it fails to parse, treat as absent without affecting the message itself
struct MessageExtra: Decodable, Hashable {
    struct Coordination: Decodable, Hashable {
        let phase: String?
        let assigneeId: String?
    }
    let steps: [String]
    let coordination: Coordination?
    let hasAgentReply: Bool
    /// Snapshot of the original message kept when replying
    let quote: MessageQuote?

    private enum Keys: String, CodingKey { case steps, coordination, agentReply, quote }

    init(from decoder: Decoder) throws {
        let container = try? decoder.container(keyedBy: Keys.self)
        steps = (try? container?.decodeIfPresent([String].self, forKey: .steps)) ?? []
        coordination = (try? container?.decodeIfPresent(Coordination.self, forKey: .coordination)) ?? nil
        hasAgentReply = container?.contains(.agentReply) ?? false
        quote = (try? container?.decodeIfPresent(MessageQuote.self, forKey: .quote)) ?? nil
    }
}

struct MessageQuote: Codable, Hashable {
    let senderId: String
    /// One-line preview, already truncated
    let text: String
}

struct SendMessageExtra: Encodable {
    let quote: MessageQuote
}

struct SendMessageRequest: Encodable {
    let messageId: String
    let content: String
    let type = "USER"
    let mentions: [String]
    let replyTo: String?
    let extra: SendMessageExtra?
    /// IDs of attachments already registered and uploaded; this field is omitted when there are no attachments
    let attachments: [String]?
}

struct CreateConversationRequest: Encodable {
    struct Member: Encodable {
        let userId: String
        let role: String
    }
    let name: String
    let members: [Member]
    let autoTitle: Bool
    let extra: ConversationExtra?
}

/// A working agent: which agent in which task (the server keeps this only in memory; it disappears when the round ends)
struct AgentActivity: Decodable, Hashable {
    let conversationId: String
    let agentUserId: String
    /// Latest Activity of this round
    let lines: [String]?
}

struct AddMemberRequest: Encodable {
    let userId: String
    let role: String
}

struct SeqRequest: Encodable {
    let seq: Int
}

/// Agent types supported by ADing. See conductor's agent_type for the cloud spelling.
enum AgentKind: String, CaseIterable {
    case codex, claudeCode, qoder, qoderCN, qwenCode, kiro, copilot, antigravity

    init?(cloudType: String) {
        switch cloudType.uppercased() {
        case "CODEX": self = .codex
        case "CLAUDE_CODE": self = .claudeCode
        case "QODER": self = .qoder
        case "QODER_CN": self = .qoderCN
        case "QWEN_CODE": self = .qwenCode
        case "KIRO": self = .kiro
        case "COPILOT": self = .copilot
        case "ANTIGRAVITY": self = .antigravity
        default: return nil
        }
    }

    /// Avatar in the asset catalog, same image set as desktop
    var iconName: String {
        switch self {
        case .codex: "agent-codex"
        case .claudeCode: "agent-claude-code"
        case .qoder: "agent-qoder"
        case .qoderCN: "agent-qoder-cn"
        case .qwenCode: "agent-qwen-code"
        case .kiro: "agent-kiro"
        case .copilot: "agent-copilot"
        case .antigravity: "agent-antigravity"
        }
    }

    /// Default Chinese name used by desktop when registering the agent, and the corresponding name in the English UI (same as desktop)
    var defaultNames: (zh: String, en: String) {
        switch self {
        case .codex: ("小c", "Cody")
        case .claudeCode: ("小cc", "Cleo")
        case .qoder: ("小q", "Quinn")
        case .qoderCN: ("小q-cn", "Quincy")
        case .qwenCode: ("小qw", "Gwen")
        case .kiro: ("小k", "Kira")
        case .copilot: ("小cp", "Cooper")
        case .antigravity: ("小a", "Ava")
        }
    }
}

/// Same ID rule as desktop: prefix + ULID (first 10 chars millisecond timestamp, last 16 random).
enum IDGenerator {
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    static func message() -> String { "m_" + ulid() }
    static func attachment() -> String { "f_" + ulid() }

    static func ulid() -> String {
        var time = UInt64(Date().timeIntervalSince1970 * 1000)
        var timePart = [Character]()
        for _ in 0..<10 {
            timePart.insert(alphabet[Int(time % 32)], at: 0)
            time /= 32
        }
        let randomPart = (0..<16).map { _ in alphabet[Int.random(in: 0..<32)] }
        return String(timePart + randomPart)
    }
}

/// Report reasons; codes map one-to-one to the server's UserReportService.REASONS
enum ReportReason: String, CaseIterable, Identifiable {
    case harassment = "HARASSMENT", spam = "SPAM", inappropriate = "INAPPROPRIATE", other = "OTHER"

    var id: String { rawValue }

    var title: LocalizedStringResource {
        switch self {
        case .harassment: "report.reason.harassment"
        case .spam: "report.reason.spam"
        case .inappropriate: "report.reason.inappropriate"
        case .other: "report.reason.other"
        }
    }
}

/// Update check (same endpoint as desktop, platform set to ios). Mobile only uses it to tell whether a forced update is required.
struct UpdateCheckRequest: Encodable {
    let platform = "ios"
    let channel: String
    let arch: String
    let currentVersion: String
}

struct UpdateCheckResponse: Decodable {
    let available: Bool
    let update: Update?

    struct Update: Decodable {
        let version: String
        /// Release builds use the App Store page; TestFlight pre-release builds may use a test invite link.
        let url: String?
        /// A forced version lies among the skipped versions: unusable until updated to requiredVersion
        let mandatory: Bool
        let requiredVersion: String?
    }
}

/// MQTT connection credentials are short-lived and held only in memory.
struct TerminalRegistration: Decodable {
    let terminalId: String
    let name: String
    let nodeToken: String
}
struct MqttCredentials: Decodable {
    let enabled: Bool
    let terminalId: String
    let brokerUrl: String?
    let clientId: String?
    let username: String?
    let password: String?
    let subscriptions: [String]
    let reportTopic: String?
    let expiresAt: Double
    let keepAliveSeconds: Int
}
struct MqttFrame: Decodable {
    let type: String
    let payload: Payload?
    struct Payload: Decodable {
        let conversationId: String?
        let agentUserId: String?
        let busy: Bool?
        let text: String?
        let sentAt: Double?
        let eventId: String?
    }
}
