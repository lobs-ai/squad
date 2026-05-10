import SwiftUI

// AppState — owns the connection, the list of paired squads, and the active selection.
// Views read everything from here through @EnvironmentObject.

@MainActor
final class AppState: ObservableObject {
    @Published var paired: [PairedSquad] = []
    @Published var activeSquadId: String? {         // PairedSquad.id (== url)
        didSet { UserDefaults.standard.set(activeSquadId, forKey: Defaults.activeSquadId) }
    }
    @Published var allSquadsMode: Bool = false {    // aggregate overview across squads
        didSet { UserDefaults.standard.set(allSquadsMode, forKey: Defaults.allSquadsMode) }
    }
    @Published var identity: AdminIdentity?         // for the active squad

    // Live data caches (populated from RPCs + WS events)
    @Published var sessions: [SessionRecord] = []
    @Published var tasks: [TaskRecord] = []
    @Published var questions: [QuestionRecord] = []
    @Published var approvals: [ApprovalRecord] = []
    @Published var peers: [AdminPeer] = []

    @Published var lastError: String?

    let client = SquadClient()
    private var eventTask: Task<Void, Never>?

    private enum Defaults {
        static let activeSquadId = "activeSquadId"
        static let allSquadsMode = "allSquadsMode"
    }

    init() {
        self.paired = PairedSquadStore.load()
        let storedId = UserDefaults.standard.string(forKey: Defaults.activeSquadId)
        // Only restore the stored id if it still matches a known squad; otherwise
        // fall back to whichever is first so we don't connect to a removed one.
        if let storedId, paired.contains(where: { $0.id == storedId }) {
            self.activeSquadId = storedId
        } else {
            self.activeSquadId = paired.first?.id
        }
        self.allSquadsMode = UserDefaults.standard.bool(forKey: Defaults.allSquadsMode)
    }

    var activeSquad: PairedSquad? {
        guard let id = activeSquadId else { return paired.first }
        return paired.first(where: { $0.id == id }) ?? paired.first
    }

    var isOnboarded: Bool { !paired.isEmpty }

    // Display labels for "agent" and "you" everywhere in the UI. Falls back to
    // the same generic words the gateway defaults to so screens render sanely
    // before `admin.identity` resolves.
    var branding: Branding {
        identity?.branding ?? Branding(agentName: "agent", userName: "you")
    }

    // MARK: lifecycle

    func connectActive() {
        guard let active = activeSquad else { return }
        client.connect(active.endpoint)
        startEventListener()
        Task { await refreshAll() }
    }

    func switchTo(_ squad: PairedSquad) {
        activeSquadId = squad.id
        allSquadsMode = false
        connectActive()
    }

    func addPaired(_ squad: PairedSquad) {
        if let i = paired.firstIndex(where: { $0.id == squad.id }) { paired[i] = squad }
        else { paired.append(squad) }
        PairedSquadStore.save(paired)
        activeSquadId = squad.id
        connectActive()
    }

    func removePaired(_ id: String) {
        paired.removeAll { $0.id == id }
        PairedSquadStore.save(paired)
        if activeSquadId == id { activeSquadId = paired.first?.id }
        if paired.isEmpty {
            client.disconnect()
        } else {
            connectActive()
        }
    }

    func resetAll() {
        client.disconnect()
        paired = []
        PairedSquadStore.clear()
        activeSquadId = nil
        allSquadsMode = false
        sessions = []; tasks = []; questions = []; approvals = []; peers = []; identity = nil
    }

    // MARK: refresh

    func refreshAll() async {
        await refreshIdentity()
        await refreshSessions()
        await refreshQuestions()
        await refreshApprovals()
        await refreshTasks()
        await refreshPeers()
    }

    func refreshIdentity() async {
        do {
            let id = try await client.adminIdentity()
            self.identity = id
            // Update friendly name on the paired record.
            if let active = activeSquad, active.name != id.name {
                if let i = paired.firstIndex(where: { $0.id == active.id }) {
                    paired[i].name = id.name
                    PairedSquadStore.save(paired)
                }
            }
        } catch { /* identity is best-effort */ }
    }
    func refreshSessions() async {
        do { self.sessions = try await client.listSessions(limit: 100) }
        catch { self.lastError = error.localizedDescription }
    }
    func refreshQuestions() async {
        do { self.questions = try await client.listQuestions() }
        catch { /* server may not have any */ }
    }
    func refreshApprovals() async {
        do { self.approvals = try await client.listApprovals() }
        catch { /* */ }
    }
    func refreshTasks() async {
        // Without a session filter the server may not return all tasks, so fan out
        // across every active session and merge. Stamp each task with the
        // sessionId we used so that mutations (update/delete) can route correctly.
        var merged: [TaskRecord] = []
        let active = sessions.filter { $0.parentSessionId == nil }
        for s in active {
            if let list = try? await client.listTasks(sessionId: s.id) {
                merged.append(contentsOf: list.map { var t = $0; t.sessionId = s.id; return t })
            }
        }
        self.tasks = merged
    }
    func refreshPeers() async {
        do { self.peers = try await client.adminPeers() }
        catch { self.peers = [] }
    }

    // MARK: actions

    // Most recently-updated active (non-ended) root session — the destination for
    // task creation when the user doesn't pick one explicitly.
    var defaultTaskSession: SessionRecord? {
        sessions
            .filter { $0.parentSessionId == nil && $0.status != "ended" }
            .sorted { ($0.updatedAt ?? "") > ($1.updatedAt ?? "") }
            .first
    }

    func updateTaskStatus(_ task: TaskRecord, status: String) async {
        guard let sid = task.sessionId else { return }
        do { _ = try await client.updateTask(sessionId: sid, taskId: task.id, status: status) }
        catch { self.lastError = error.localizedDescription }
    }

    func saveTaskEdits(
        _ task: TaskRecord,
        subject: String,
        description: String,
        owner: String?,
        status: String
    ) async {
        guard let sid = task.sessionId else { return }
        let trimmedOwner = owner?.trimmingCharacters(in: .whitespacesAndNewlines)
        let ownerArg: String?? = (trimmedOwner?.isEmpty ?? true) ? .some(nil) : .some(trimmedOwner)
        do {
            _ = try await client.updateTask(
                sessionId: sid,
                taskId: task.id,
                subject: subject,
                description: description,
                owner: ownerArg,
                status: status
            )
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func deleteTask(_ task: TaskRecord) async {
        guard let sid = task.sessionId else { return }
        do { _ = try await client.deleteTask(sessionId: sid, taskId: task.id) }
        catch { self.lastError = error.localizedDescription }
    }

    func createTask(subject: String, description: String = "") async {
        guard let session = defaultTaskSession else {
            self.lastError = "No active session to attach the task to"
            return
        }
        do { _ = try await client.createTask(sessionId: session.id, subject: subject, description: description) }
        catch { self.lastError = error.localizedDescription }
    }

    // Match dashboard parity: a blank session.start with no opts. Title/model
    // defaults come from the gateway; the user types their first message in the
    // chat view, which auto-titles from that message.
    func startBlankSession() async -> String? {
        do {
            let session = try await client.startSession(title: nil, model: nil, prompt: nil)
            await refreshSessions()
            return session.id
        } catch {
            self.lastError = error.localizedDescription
            return nil
        }
    }

    // MARK: events

    private func startEventListener() {
        eventTask?.cancel()
        // Subscribe to broadcast topics that affect the global caches.
        client.subscribe([
            "session.created", "session.updated",
            "tasks.created", "tasks.updated", "tasks.deleted",
            "questions.asked", "questions.answered", "questions.cancelled", "questions.timed_out",
            "approvals.pending", "approvals.decided",
            "peers.changed",
        ])
        eventTask = Task { [weak self] in
            guard let self else { return }
            for await event in self.client.events.stream() {
                self.handle(event: event)
            }
        }
    }

    private func handle(event: AsyncEventStream.Event) {
        switch event.topic {
        case "session.created", "session.updated":
            // Reload list — cheap, and avoids reasoning about sort order.
            Task { await refreshSessions() }
        case "tasks.created", "tasks.updated", "tasks.deleted":
            Task { await refreshTasks() }
        case "questions.asked", "questions.answered", "questions.cancelled", "questions.timed_out":
            Task { await refreshQuestions() }
        case "approvals.pending", "approvals.decided":
            Task { await refreshApprovals() }
        case "peers.changed":
            Task { await refreshPeers() }
        default:
            break
        }
    }
}
