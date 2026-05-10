import Foundation

// MARK: - Frame model
// Raw wire frames spoken on /ws. We send dictionaries; we decode incoming frames
// into this discriminated union.

enum IncomingFrame {
    case response(id: String, ok: Bool, result: AnyCodable?, errorCode: String?, errorMessage: String?)
    case event(topic: String, data: AnyCodable)
    case unknown
}

private func decodeIncomingFrame(_ data: Data) throws -> IncomingFrame {
    guard
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
        let type = obj["type"] as? String
    else {
        return .unknown
    }
    switch type {
    case "response":
        let id = obj["id"] as? String ?? ""
        let ok = obj["ok"] as? Bool ?? false
        if ok {
            let resultVal: AnyCodable? = (obj["result"]).flatMap { reencode($0) }
            return .response(id: id, ok: true, result: resultVal, errorCode: nil, errorMessage: nil)
        } else {
            let env = obj["error"] as? [String: Any]
            return .response(id: id, ok: false, result: nil,
                             errorCode: env?["code"] as? String,
                             errorMessage: env?["message"] as? String)
        }
    case "event":
        let topic = obj["topic"] as? String ?? ""
        let data: AnyCodable = (obj["data"]).flatMap { reencode($0) } ?? .null
        return .event(topic: topic, data: data)
    default:
        return .unknown
    }
}

private func reencode(_ value: Any) -> AnyCodable? {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else {
        return nil
    }
    return try? JSONDecoder().decode(AnyCodable.self, from: bytes)
}

// MARK: - Client errors

enum SquadClientError: LocalizedError {
    case notConnected
    case timedOut
    case rpc(code: String, message: String)
    case decode(String)
    case http(status: Int, body: String?)
    case invalidURL(String)

    var errorDescription: String? {
        switch self {
        case .notConnected: "not connected to a squad"
        case .timedOut:     "request timed out"
        case .rpc(let c, let m): "\(c): \(m)"
        case .decode(let m):     "decode error: \(m)"
        case .http(let s, let b): "http \(s): \(b ?? "")"
        case .invalidURL(let s): "invalid url: \(s)"
        }
    }
}

// MARK: - Connection state

enum ConnectionStatus: Equatable {
    case disconnected
    case connecting
    case connected
    case failed(String)
}

// MARK: - Squad endpoint

struct SquadEndpoint: Codable, Hashable {
    var url: String        // e.g. "https://your-mbp.tail-scale.ts.net:8080"
    var token: String
}

// MARK: - SquadClient

@MainActor
final class SquadClient: ObservableObject {

    // Public state (observed by SwiftUI)
    @Published private(set) var status: ConnectionStatus = .disconnected
    @Published private(set) var subscribedTopics: Set<String> = []

    // Stream of decoded events; ViewModels subscribe via `events`.
    let events = AsyncEventStream()

    // Private state
    private(set) var endpoint: SquadEndpoint?
    private var ws: URLSessionWebSocketTask?
    private var session: URLSession?
    private var pending: [String: CheckedContinuation<AnyCodable, Error>] = [:]
    private var reconnectTask: Task<Void, Never>?
    private var receiveTask: Task<Void, Never>?

    // MARK: connection lifecycle

    func connect(_ endpoint: SquadEndpoint) {
        disconnect()
        self.endpoint = endpoint
        self.status = .connecting
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        cfg.waitsForConnectivity = false
        let session = URLSession(configuration: cfg)
        self.session = session

        guard let wsURL = Self.buildWSURL(endpoint) else {
            self.status = .failed("invalid url")
            return
        }
        var req = URLRequest(url: wsURL)
        req.setValue("Bearer \(endpoint.token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: req)
        self.ws = task
        task.resume()
        self.status = .connected   // optimistically; first failure flips us back
        startReceiveLoop()
        // ping to verify auth/health quickly
        Task { [weak self] in
            do {
                _ = try await self?.callRaw("admin.health", params: nil)
            } catch {
                self?.handleConnectionFailure("health check failed: \(error.localizedDescription)")
            }
        }
    }

    func disconnect() {
        reconnectTask?.cancel(); reconnectTask = nil
        receiveTask?.cancel(); receiveTask = nil
        ws?.cancel(with: .goingAway, reason: nil)
        ws = nil
        session?.invalidateAndCancel()
        session = nil
        // Fail any in-flight RPCs so callers don't hang.
        for (_, cont) in pending { cont.resume(throwing: SquadClientError.notConnected) }
        pending.removeAll()
        subscribedTopics.removeAll()
        status = .disconnected
    }

    private func handleConnectionFailure(_ reason: String) {
        status = .failed(reason)
        ws?.cancel(); ws = nil
        for (_, cont) in pending { cont.resume(throwing: SquadClientError.notConnected) }
        pending.removeAll()
    }

    private func startReceiveLoop() {
        guard let ws else { return }
        receiveTask = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    let msg = try await ws.receive()
                    let data: Data?
                    switch msg {
                    case .data(let d): data = d
                    case .string(let s): data = s.data(using: .utf8)
                    @unknown default: data = nil
                    }
                    if let data, let frame = try? decodeIncomingFrame(data) {
                        self?.handleIncoming(frame)
                    }
                } catch {
                    self?.handleConnectionFailure("ws read failed: \(error.localizedDescription)")
                    return
                }
            }
        }
    }

    private func handleIncoming(_ frame: IncomingFrame) {
        switch frame {
        case .response(let id, let ok, let result, let code, let message):
            guard let cont = pending.removeValue(forKey: id) else { return }
            if ok {
                cont.resume(returning: result ?? .null)
            } else {
                cont.resume(throwing: SquadClientError.rpc(
                    code: code ?? "rpc_error",
                    message: message ?? "request failed"
                ))
            }
        case .event(let topic, let data):
            events.publish(topic: topic, data: data)
        case .unknown:
            break
        }
    }

    // MARK: RPC

    @discardableResult
    func callRaw(_ method: String, params: [String: Any]?) async throws -> AnyCodable {
        guard let ws else { throw SquadClientError.notConnected }
        let id = UUID().uuidString
        var frame: [String: Any] = ["type": "request", "id": id, "method": method]
        if let params { frame["params"] = params }
        let data = try JSONSerialization.data(withJSONObject: frame, options: [.fragmentsAllowed])
        let str = String(data: data, encoding: .utf8) ?? "{}"
        return try await withCheckedThrowingContinuation { (cont: CheckedContinuation<AnyCodable, Error>) in
            self.pending[id] = cont
            ws.send(.string(str)) { [weak self] error in
                if let error {
                    Task { @MainActor in
                        if let cont = self?.pending.removeValue(forKey: id) {
                            cont.resume(throwing: SquadClientError.rpc(
                                code: "send_failed", message: error.localizedDescription
                            ))
                        }
                    }
                }
            }
            // Cap individual RPCs at 25s.
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                if let cont = self?.pending.removeValue(forKey: id) {
                    cont.resume(throwing: SquadClientError.timedOut)
                }
            }
        }
    }

    func call<R: Decodable>(_ method: String, params: [String: Any]? = nil, as type: R.Type) async throws -> R {
        let result = try await callRaw(method, params: params)
        let bytes = try JSONEncoder().encode(result)
        do {
            return try JSONDecoder().decode(R.self, from: bytes)
        } catch {
            throw SquadClientError.decode("\(method): \(error)")
        }
    }

    // MARK: Subscriptions

    func subscribe(_ topics: [String]) {
        guard let ws, !topics.isEmpty else { return }
        subscribedTopics.formUnion(topics)
        let frame: [String: Any] = ["type": "subscribe", "id": UUID().uuidString, "topics": topics]
        if let data = try? JSONSerialization.data(withJSONObject: frame),
           let str = String(data: data, encoding: .utf8) {
            ws.send(.string(str)) { _ in }
        }
    }
    func unsubscribe(_ topics: [String]) {
        guard let ws, !topics.isEmpty else { return }
        subscribedTopics.subtract(topics)
        let frame: [String: Any] = ["type": "unsubscribe", "id": UUID().uuidString, "topics": topics]
        if let data = try? JSONSerialization.data(withJSONObject: frame),
           let str = String(data: data, encoding: .utf8) {
            ws.send(.string(str)) { _ in }
        }
    }

    // MARK: URL helpers — pure functions, callable from any actor

    nonisolated static func buildWSURL(_ endpoint: SquadEndpoint) -> URL? {
        guard var comps = URLComponents(string: endpoint.url) else { return nil }
        switch comps.scheme?.lowercased() {
        case "http":  comps.scheme = "ws"
        case "https": comps.scheme = "wss"
        default: break
        }
        let basePath = (comps.path.isEmpty || comps.path == "/") ? "" : comps.path
        comps.path = basePath + "/ws"
        comps.queryItems = [URLQueryItem(name: "token", value: endpoint.token)]
        return comps.url
    }
    nonisolated static func buildHTTPURL(_ baseURL: String, path: String) -> URL? {
        guard var comps = URLComponents(string: baseURL) else { return nil }
        let basePath = (comps.path.isEmpty || comps.path == "/") ? "" : comps.path
        comps.path = basePath + path
        return comps.url
    }
}

// MARK: - Unauthenticated HTTP helpers (used by pairing flow before we have a token)

enum SquadHTTP {
    static func postJSON<R: Decodable>(_ baseURL: String, path: String, body: [String: Any]?, as type: R.Type) async throws -> R {
        guard let url = SquadClient.buildHTTPURL(baseURL, path: path) else {
            throw SquadClientError.invalidURL(baseURL + path)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        else { req.httpBody = "{}".data(using: .utf8) }
        let (data, resp) = try await URLSession.shared.data(for: req)
        let http = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(http) else {
            throw SquadClientError.http(status: http, body: String(data: data, encoding: .utf8))
        }
        return try JSONDecoder().decode(R.self, from: data)
    }
    static func getJSON<R: Decodable>(_ baseURL: String, path: String, query: [String: String] = [:], as type: R.Type) async throws -> R {
        guard var comps = URLComponents(string: baseURL) else {
            throw SquadClientError.invalidURL(baseURL)
        }
        let basePath = (comps.path.isEmpty || comps.path == "/") ? "" : comps.path
        comps.path = basePath + path
        if !query.isEmpty {
            comps.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = comps.url else { throw SquadClientError.invalidURL(baseURL + path) }
        let (data, resp) = try await URLSession.shared.data(from: url)
        let http = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(http) else {
            throw SquadClientError.http(status: http, body: String(data: data, encoding: .utf8))
        }
        return try JSONDecoder().decode(R.self, from: data)
    }
}

// MARK: - Async event stream
// Lightweight pub/sub for events received over the WebSocket. We don't try to be
// clever about topic matching; subscribers filter the stream themselves.

@MainActor
final class AsyncEventStream {
    struct Event { let topic: String; let data: AnyCodable }
    private var continuations: [UUID: AsyncStream<Event>.Continuation] = [:]

    func publish(topic: String, data: AnyCodable) {
        for (_, c) in continuations { c.yield(Event(topic: topic, data: data)) }
    }
    func stream() -> AsyncStream<Event> {
        AsyncStream { continuation in
            let id = UUID()
            self.continuations[id] = continuation
            continuation.onTermination = { @Sendable _ in
                Task { @MainActor in self.continuations.removeValue(forKey: id) }
            }
        }
    }
}

// MARK: - High level RPC wrappers

extension SquadClient {

    // Sessions
    struct SessionListResult: Codable { let sessions: [SessionRecord]; let nextCursor: String? }
    func listSessions(parent: String? = nil, limit: Int = 50) async throws -> [SessionRecord] {
        var p: [String: Any] = ["limit": limit]
        if let parent { p["parentSessionId"] = parent }
        let r = try await call("session.list", params: p, as: SessionListResult.self)
        return r.sessions
    }
    struct SessionStartResult: Codable { let session: SessionRecord }
    func startSession(title: String?, model: String?, prompt: String?) async throws -> SessionRecord {
        var p: [String: Any] = [:]
        if let title, !title.isEmpty { p["title"] = title }
        if let model, !model.isEmpty { p["model"] = model }
        if let prompt, !prompt.isEmpty { p["systemPrompt"] = prompt }
        let r = try await call("session.start", params: p, as: SessionStartResult.self)
        return r.session
    }

    // Chat
    struct ChatHistoryResult: Codable { let messages: [MessageRecord] }
    func chatHistory(sessionId: String, limit: Int = 200) async throws -> [MessageRecord] {
        let r = try await call("chat.history", params: ["sessionId": sessionId, "limit": limit], as: ChatHistoryResult.self)
        return r.messages
    }
    struct ChatSendResult: Codable { let runId: String?; let status: String? }
    func chatSend(sessionId: String, content: String) async throws {
        _ = try await call("chat.send", params: ["sessionId": sessionId, "content": content], as: ChatSendResult.self)
    }

    // Tasks
    struct TasksListResult: Codable { let tasks: [TaskRecord] }
    func listTasks(sessionId: String? = nil) async throws -> [TaskRecord] {
        var p: [String: Any] = [:]
        if let sessionId { p["sessionId"] = sessionId }
        let r = try await call("tasks.list", params: p, as: TasksListResult.self)
        return r.tasks
    }
    struct TaskMutationResult: Codable { let task: TaskRecord }
    func createTask(sessionId: String, subject: String, description: String = "") async throws -> TaskRecord {
        let r = try await call(
            "tasks.create",
            params: ["sessionId": sessionId, "subject": subject, "description": description],
            as: TaskMutationResult.self
        )
        return r.task
    }
    // Pass `.some(nil)` to owner to clear it; `.none` to leave it alone.
    func updateTask(
        sessionId: String,
        taskId: String,
        subject: String? = nil,
        description: String? = nil,
        owner: String?? = nil,
        status: String? = nil
    ) async throws -> TaskRecord {
        var p: [String: Any] = ["sessionId": sessionId, "taskId": taskId]
        if let subject { p["subject"] = subject }
        if let description { p["description"] = description }
        if case .some(let v) = owner { p["owner"] = (v as Any?) ?? NSNull() }
        if let status { p["status"] = status }
        let r = try await call("tasks.update", params: p, as: TaskMutationResult.self)
        return r.task
    }
    func deleteTask(sessionId: String, taskId: String) async throws -> TaskRecord {
        let r = try await call(
            "tasks.delete",
            params: ["sessionId": sessionId, "taskId": taskId],
            as: TaskMutationResult.self
        )
        return r.task
    }

    // Questions
    struct QuestionsListResult: Codable { let questions: [QuestionRecord] }
    func listQuestions(status: [String] = ["pending"]) async throws -> [QuestionRecord] {
        let r = try await call("questions.list", params: ["status": status], as: QuestionsListResult.self)
        return r.questions
    }
    struct QuestionsAnswerResult: Codable { let question: QuestionRecord }
    func answerQuestion(sessionId: String, questionId: String, answers: [String: String]) async throws {
        _ = try await call("questions.answer",
                           params: ["sessionId": sessionId, "questionId": questionId, "answers": answers],
                           as: QuestionsAnswerResult.self)
    }
    struct QuestionsCancelResult: Codable { let question: QuestionRecord }
    func cancelQuestion(sessionId: String, questionId: String, reason: String? = nil) async throws {
        var p: [String: Any] = ["sessionId": sessionId, "questionId": questionId]
        if let reason { p["reason"] = reason }
        _ = try await call("questions.cancel", params: p, as: QuestionsCancelResult.self)
    }

    // Approvals
    struct ApprovalsListResult: Codable { let approvals: [ApprovalRecord] }
    func listApprovals(status: [String] = ["pending"]) async throws -> [ApprovalRecord] {
        let r = try await call("approvals.list", params: ["status": status], as: ApprovalsListResult.self)
        return r.approvals
    }
    struct ApprovalsDecideResult: Codable { let approval: ApprovalRecord }
    func decideApproval(id: String, decision: String, reason: String? = nil) async throws {
        var p: [String: Any] = ["approvalId": id, "decision": decision]
        if let reason { p["reason"] = reason }
        _ = try await call("approvals.decide", params: p, as: ApprovalsDecideResult.self)
    }

    // Subagents
    struct SubagentsListResult: Codable { let definitions: [SubagentDefinition] }
    func listSubagentDefinitions() async throws -> [SubagentDefinition] {
        let r = try await call("subagents.list", params: nil, as: SubagentsListResult.self)
        return r.definitions
    }
    struct SubagentsTreeResult: Codable { let root: SubagentTreeNode }
    func subagentTree(rootSessionId: String) async throws -> SubagentTreeNode {
        let r = try await call("subagents.tree", params: ["rootSessionId": rootSessionId], as: SubagentsTreeResult.self)
        return r.root
    }
    struct SubagentsSpawnResult: Codable { let sessionId: String; let status: String? }
    func spawnSubagent(parent: String, name: String, prompt: String, model: String?) async throws -> SubagentsSpawnResult {
        var p: [String: Any] = ["parentSessionId": parent, "subagent": name, "prompt": prompt]
        if let model { p["model"] = model }
        return try await call("subagents.spawn", params: p, as: SubagentsSpawnResult.self)
    }

    // Search
    struct SearchResult: Codable { let hits: [SearchHit] }
    func searchSessions(query: String, limit: Int = 30) async throws -> [SearchHit] {
        let r = try await call("session.search", params: ["query": query, "limit": limit], as: SearchResult.self)
        return r.hits
    }

    // Admin / squad metadata
    func adminHealth() async throws -> AdminHealth {
        try await call("admin.health", params: nil, as: AdminHealth.self)
    }
    func adminIdentity() async throws -> AdminIdentity {
        try await call("admin.identity", params: nil, as: AdminIdentity.self)
    }
    struct PeersResult: Codable { let peers: [AdminPeer] }
    func adminPeers() async throws -> [AdminPeer] {
        let r = try await call("admin.peers", params: nil, as: PeersResult.self)
        return r.peers
    }

    // Models catalogue
    struct ModelsResult: Codable {
        struct Model: Codable, Identifiable, Hashable {
            var id: String
            let displayName: String?
            let provider: String?
        }
        let models: [Model]
    }
    func adminModels() async throws -> [ModelsResult.Model] {
        try await call("admin.models", params: nil, as: ModelsResult.self).models
    }
}
