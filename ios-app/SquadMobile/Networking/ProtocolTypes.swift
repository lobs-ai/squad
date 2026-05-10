import Foundation

// AnyCodable — minimal heterogeneous JSON value for opaque tool inputs/results.
// Mirrors what the dashboard's TS client treats as `unknown`.
enum AnyCodable: Codable, Equatable, Hashable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([AnyCodable])
    case object([String: AnyCodable])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null; return }
        if let b = try? c.decode(Bool.self) { self = .bool(b); return }
        if let n = try? c.decode(Double.self) { self = .number(n); return }
        if let s = try? c.decode(String.self) { self = .string(s); return }
        if let a = try? c.decode([AnyCodable].self) { self = .array(a); return }
        if let o = try? c.decode([String: AnyCodable].self) { self = .object(o); return }
        throw DecodingError.dataCorruptedError(in: c, debugDescription: "unsupported JSON value")
    }
    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null:        try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    // Convenience accessors
    var stringValue: String? { if case .string(let s) = self { s } else { nil } }
    var numberValue: Double? { if case .number(let n) = self { n } else { nil } }
    var objectValue: [String: AnyCodable]? { if case .object(let o) = self { o } else { nil } }
    var arrayValue: [AnyCodable]? { if case .array(let a) = self { a } else { nil } }

    // Pretty-print (used in tool bubble bodies).
    var prettyString: String {
        switch self {
        case .null: "null"
        case .bool(let b): String(b)
        case .number(let n): n.truncatingRemainder(dividingBy: 1) == 0 ? String(Int(n)) : String(n)
        case .string(let s): s
        case .array, .object:
            (try? String(data: JSONEncoder.pretty.encode(self), encoding: .utf8)) ?? "—"
        }
    }
}

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
}

// MARK: - Records

struct SessionRecord: Codable, Identifiable, Hashable {
    let id: String
    var parentSessionId: String?
    var subagentDefId: String?
    var title: String?
    var platform: String?
    var remoteId: String?
    var model: String
    var fallbacks: [String]?
    var titleModel: String?
    var status: String  // "idle" | "running" | "ended"
    var deliveryMode: String?
    var tokensIn: Int?
    var tokensOut: Int?
    var createdAt: String?
    var updatedAt: String?

    var displayTitle: String { (title?.isEmpty == false ? title : nil) ?? "Untitled session" }
    var isStreaming: Bool { status == "running" }
}

struct ContentBlock: Codable, Hashable {
    let type: String
    let text: String?
    let id: String?
    let name: String?
    let input: AnyCodable?
    let toolUseId: String?
    let content: AnyCodable?      // tool result body (string or object)
    let isError: Bool?
    let mimeType: String?
    let data: String?

    enum CodingKeys: String, CodingKey {
        case type, text, id, name, input
        case toolUseId = "tool_use_id"
        case content, isError = "is_error"
        case mimeType = "mime_type"
        case data
    }
}

struct MessageRecord: Codable, Identifiable, Hashable {
    let id: String
    let sessionId: String
    let role: String        // "system" | "user" | "assistant" | "tool"
    let content: [ContentBlock]
    let createdAt: String?

    var combinedText: String {
        content.compactMap { $0.text }.joined(separator: "\n")
    }
}

struct TaskRecord: Codable, Identifiable, Hashable {
    let id: String
    var taskListId: String?
    var subject: String
    var description: String?
    var activeForm: String?
    var owner: String?
    var status: String      // "pending" | "in_progress" | "completed" | "deleted"
    var blocks: [String]?
    var blockedBy: [String]?
    var createdAt: String?
    var updatedAt: String?
}

struct AskOption: Codable, Hashable {
    let label: String
    let description: String?
    let preview: String?
}
struct AskQuestion: Codable, Hashable {
    let header: String
    let question: String
    let options: [AskOption]
    let multiSelect: Bool?
}
struct AskInput: Codable, Hashable {
    let questions: [AskQuestion]
    let timeoutSeconds: Int?
    let allowCustom: Bool?
}

struct QuestionRecord: Codable, Identifiable, Hashable {
    let id: String
    let sessionId: String
    let askedBy: String?
    let askedAt: String?
    let answeredAt: String?
    let timedOutAt: String?
    let status: String      // "pending" | "answered" | "cancelled" | "timed_out"
    let input: AskInput
    let answers: [String: String]?
}

struct ApprovalRecord: Codable, Identifiable, Hashable {
    let id: String
    let sessionId: String
    let toolCallId: String?
    let toolName: String
    let input: AnyCodable?
    let tags: [String]?
    let status: String      // "pending" | "approved" | "denied" | "timed_out"
    let decision: String?
    let reason: String?
    let decidedBy: String?
    let decidedAt: String?
    let createdAt: String?

    var primaryTag: String {
        if let tags, let first = tags.first { return first }
        return "tool"
    }
}

struct SubagentDefinition: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let description: String?
    let model: String?
    let tools: [String]?
}

struct SubagentTreeNode: Codable, Identifiable, Hashable {
    var id: String { sessionId }
    let sessionId: String
    let subagent: String?
    let title: String?
    let status: String?
    let model: String?
    let tokensIn: Int?
    let tokensOut: Int?
    let children: [SubagentTreeNode]?
}

struct AdminIdentity: Codable, Hashable {
    let name: String
    let port: Int
    let host: String?
    let build: String?
    let version: String?
    let startedAt: String?
}

struct AdminPeer: Codable, Identifiable, Hashable {
    var id: String { name }
    let name: String
    let port: Int?
    let url: String?
    let status: String      // "healthy" | "starting" | "stopped" | "unhealthy" | "unknown"
    let build: String?
    let startedAt: String?
}

struct AdminHealth: Codable, Hashable {
    let ok: Bool
    let version: String?
    let uptimeSeconds: Double?
}

struct SearchHit: Codable, Identifiable, Hashable {
    var id: String { messageId ?? "\(sessionId)-\(ts ?? "")" }
    let session: SessionRecord?
    let sessionId: String
    let messageId: String?
    let snippet: String
    let ts: String?
    let score: Double?
}

// Pairing flow returns plain dictionaries — model them explicitly.
struct PairingBegin: Codable {
    let pairing: PairingView
}
struct PairingView: Codable {
    let code: String
    let label: String?
    let scopes: [String]?
    let status: String      // "pending" | "approved" | "claimed" | "expired" | "cancelled"
    let createdAt: String?
    let expiresAt: String?
}
struct PairingPoll: Codable {
    let status: String
    let token: String?
    let label: String?
    let expiresAt: String?
}
