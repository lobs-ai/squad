import SwiftUI

// Live chat for one session. Pulls history on appear, then subscribes to:
//   chat.text_delta/<sessionId>
//   chat.assistant_message/<sessionId>
//   chat.user_message/<sessionId>
//   chat.tool_call/<sessionId>
//   chat.tool_result/<sessionId>
// and renders bubbles, tool bubbles, subagent dots, and the streaming caret.

struct ChatView: View {
    @EnvironmentObject var state: AppState
    let sessionId: String
    var go: (NavigationIntent) -> Void

    @State private var resumedSession: SessionRecord?
    @State private var messages: [MessageRecord] = []
    @State private var streamingDelta: String = ""    // live tokens since last assistant message
    @State private var pendingToolCalls: [String: PendingToolCall] = [:]
    @State private var draft: String = ""
    @State private var sending = false
    @State private var awaitingResponse = false       // user sent / tool returned → agent thinking
    @State private var showSubagents = false
    @State private var subscriptionTask: Task<Void, Never>?

    // Prefer the live record from AppState so status flips ("idle" → "running"
    // → "ended") drive the header pulse and the thinking indicator. Fall back
    // to a fetched-by-resume copy for sessions not yet in the cache.
    private var session: SessionRecord? {
        state.sessions.first(where: { $0.id == sessionId }) ?? resumedSession
    }
    private var isThinking: Bool {
        awaitingResponse && streamingDelta.isEmpty && pendingApprovals.isEmpty
    }

    private let perSessionTopics: [String]
    init(sessionId: String, go: @escaping (NavigationIntent) -> Void) {
        self.sessionId = sessionId
        self.go = go
        self.perSessionTopics = [
            "chat.text_delta/\(sessionId)",
            "chat.assistant_message/\(sessionId)",
            "chat.user_message/\(sessionId)",
            "chat.tool_call/\(sessionId)",
            "chat.tool_result/\(sessionId)",
            "chat.error/\(sessionId)",
        ]
    }

    struct PendingToolCall { let name: String; let input: AnyCodable? }

    var body: some View {
        ZStack {
            Tokens.bg.ignoresSafeArea()

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 8) {
                        Color.clear.frame(height: 110)
                        if messages.isEmpty && streamingDelta.isEmpty {
                            emptyChatPlaceholder
                        }
                        ForEach(messages) { msg in
                            messageView(msg)
                                .id(msg.id)
                        }
                        if !streamingDelta.isEmpty {
                            assistantBubble(text: streamingDelta, streaming: true)
                                .id("__streaming")
                        }
                        if isThinking {
                            thinkingBubble
                                .id("__thinking")
                        }
                        if !pendingApprovals.isEmpty {
                            pendingApprovalBanner
                        }
                        Color.clear.frame(height: 110).id("__bottom")
                    }
                    .padding(.horizontal, 16)
                }
                .scrollIndicators(.hidden)
                .onChange(of: messages.count) { _, _ in
                    withAnimation { proxy.scrollTo("__bottom", anchor: .bottom) }
                }
                .onChange(of: streamingDelta) { _, _ in
                    proxy.scrollTo("__bottom", anchor: .bottom)
                }
                .onChange(of: awaitingResponse) { _, _ in
                    proxy.scrollTo("__bottom", anchor: .bottom)
                }
            }

            // Header
            VStack(spacing: 0) {
                ChatHeader(
                    session: session,
                    sessionId: sessionId,
                    subagentBadge: subagentCount,
                    onBack: { go(.back) },
                    onSubagents: { showSubagents = true }
                )
                Spacer()
            }

            // Composer
            VStack(spacing: 0) {
                Spacer()
                Composer(text: $draft,
                         sending: sending,
                         placeholder: "Reply to \(state.branding.agentName)…",
                         onSend: send)
            }
        }
        .task { await onFirstAppear() }
        .onDisappear {
            subscriptionTask?.cancel()
            state.client.unsubscribe(perSessionTopics)
        }
        .sheet(isPresented: $showSubagents) {
            SubagentSheet(rootSessionId: sessionId, onClose: { showSubagents = false })
                .presentationDetents([.medium, .large])
                .presentationBackground(Color(hex: 0x161616))
        }
    }

    // MARK: derived

    private var subagentCount: Int {
        // Sessions whose parent is this session.
        state.sessions.filter { $0.parentSessionId == sessionId }.count
    }
    private var pendingApprovals: [ApprovalRecord] {
        state.approvals.filter { $0.sessionId == sessionId && $0.status == "pending" }
    }

    private var emptyChatPlaceholder: some View {
        VStack(spacing: 8) {
            Image(systemName: "sparkles")
                .font(.system(size: 22, weight: .light))
                .foregroundStyle(Tokens.fgDim)
            Text("Empty session")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Tokens.fgMuted)
            Text("Start by typing a message below.")
                .font(.system(size: 12))
                .foregroundStyle(Tokens.fgDim)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
    }

    // MARK: lifecycle

    private func onFirstAppear() async {
        if state.sessions.first(where: { $0.id == sessionId }) == nil {
            let resumed = try? await state.client.call(
                "session.resume",
                params: ["sessionId": sessionId],
                as: SquadClient.SessionStartResult.self
            )
            self.resumedSession = resumed?.session
        }
        do {
            self.messages = try await state.client.chatHistory(sessionId: sessionId)
        } catch {
            state.lastError = error.localizedDescription
        }
        // If we're attaching to a session that's already in flight, show the
        // thinking indicator until a delta or assistant message lands. Events
        // for tool_call / tool_result will adjust this in handle().
        if session?.status == "running", messages.last?.role != "assistant" {
            awaitingResponse = true
        }
        state.client.subscribe(perSessionTopics)
        subscriptionTask = Task { @MainActor in
            for await event in state.client.events.stream() {
                guard event.topic.hasSuffix("/\(sessionId)") else { continue }
                handle(event)
            }
        }
    }

    private func handle(_ event: AsyncEventStream.Event) {
        let prefix = String(event.topic.split(separator: "/").first ?? "")
        switch prefix {
        case "chat.text_delta":
            if let obj = event.data.objectValue, let delta = obj["delta"]?.stringValue {
                streamingDelta += delta
                awaitingResponse = false
            }
        case "chat.assistant_message":
            if let obj = event.data.objectValue, let msgVal = obj["message"] {
                if let bytes = try? JSONEncoder().encode(msgVal),
                   let msg = try? JSONDecoder().decode(MessageRecord.self, from: bytes) {
                    messages.append(msg)
                    streamingDelta = ""
                    awaitingResponse = false
                }
            }
        case "chat.user_message":
            if let obj = event.data.objectValue, let msgVal = obj["message"],
               let bytes = try? JSONEncoder().encode(msgVal),
               let msg = try? JSONDecoder().decode(MessageRecord.self, from: bytes) {
                if !messages.contains(where: { $0.id == msg.id }) { messages.append(msg) }
                // A user turn means the agent is about to think.
                awaitingResponse = true
            }
        case "chat.tool_call":
            if let obj = event.data.objectValue,
               let id = obj["toolCallId"]?.stringValue,
               let name = obj["name"]?.stringValue {
                pendingToolCalls[id] = .init(name: name, input: obj["input"])
                // Synthesise a tool message so the bubble appears immediately.
                let text = (obj["input"] ?? .null).prettyString
                let block = ContentBlock(type: "tool_use", text: text, id: id, name: name,
                                         input: obj["input"], toolUseId: nil, content: nil,
                                         isError: nil, mimeType: nil, data: nil)
                messages.append(MessageRecord(id: "tc_\(id)", sessionId: sessionId,
                                              role: "assistant",
                                              content: [block], createdAt: nil))
                // Mid-tool: text streaming is paused and the agent isn't
                // thinking, it's executing. The next text_delta will start a
                // fresh chunk after the result.
                streamingDelta = ""
                awaitingResponse = false
            }
        case "chat.tool_result":
            if let obj = event.data.objectValue, let id = obj["toolCallId"]?.stringValue {
                let resultText = (obj["result"] ?? .null).prettyString
                let isErr = obj["isError"].flatMap {
                    if case .bool(let b) = $0 { b } else { false }
                } ?? false
                let block = ContentBlock(type: "tool_result", text: resultText, id: nil, name: nil,
                                         input: nil, toolUseId: id, content: obj["result"],
                                         isError: isErr, mimeType: nil, data: nil)
                messages.append(MessageRecord(id: "tr_\(id)", sessionId: sessionId,
                                              role: "tool", content: [block], createdAt: nil))
                pendingToolCalls.removeValue(forKey: id)
                // Between a tool finishing and the next text/tool_use, the
                // agent is thinking again — re-arm the indicator.
                awaitingResponse = true
            }
        case "chat.error":
            if let obj = event.data.objectValue, let msg = obj["message"]?.stringValue {
                state.lastError = msg
            }
            streamingDelta = ""
            awaitingResponse = false
        default: break
        }
    }

    // MARK: actions

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !sending else { return }
        sending = true
        awaitingResponse = true
        let snapshot = text
        draft = ""
        Task {
            do {
                try await state.client.chatSend(sessionId: sessionId, content: snapshot)
            } catch {
                state.lastError = error.localizedDescription
                draft = snapshot
                awaitingResponse = false
            }
            sending = false
        }
    }

    // MARK: bubbles

    @ViewBuilder
    private func messageView(_ msg: MessageRecord) -> some View {
        switch msg.role {
        case "user":
            HStack { Spacer()
                Text(msg.combinedText)
                    .font(.system(size: 14))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Tokens.accent)
                    .clipShape(BubbleShape(role: .user))
                    .frame(maxWidth: 300, alignment: .trailing)
            }
            .padding(.vertical, 6)

        case "assistant":
            // tool_use blocks → tool bubble; otherwise text
            if let toolBlock = msg.content.first(where: { $0.type == "tool_use" }) {
                toolBubble(name: toolBlock.name ?? "tool",
                           input: toolBlock.input,
                           tag: tagFor(name: toolBlock.name ?? ""))
            } else {
                assistantBubble(text: msg.combinedText, streaming: false)
            }

        case "tool":
            if let block = msg.content.first {
                toolResultBubble(text: block.text ?? "ok", isError: block.isError == true)
            }

        default:
            EmptyView()
        }
    }

    private var thinkingBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(state.branding.agentName.uppercased())
                Text("·")
                Mono(session?.model ?? "—", size: 10, color: Tokens.fgMuted, weight: .bold)
                Text("·")
                Text("THINKING")
            }
            .font(Fonts.mono(10, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(Tokens.fgMuted)
            TypingDots()
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func assistantBubble(text: String, streaming: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(state.branding.agentName.uppercased())
                Text("·")
                Mono(session?.model ?? "—", size: 10, color: Tokens.fgMuted, weight: .bold)
            }
            .font(Fonts.mono(10, weight: .bold))
            .tracking(0.8)
            .foregroundStyle(Tokens.fgMuted)
            HStack(alignment: .lastTextBaseline, spacing: 0) {
                Text(text)
                    .font(.system(size: 14))
                    .foregroundStyle(Tokens.fg)
                    .lineSpacing(4)
                if streaming {
                    Rectangle().fill(Tokens.accent).frame(width: 6, height: 14)
                        .padding(.leading, 3)
                }
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func toolBubble(name: String, input: AnyCodable?, tag: String) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text(tag.uppercased())
                .font(Fonts.mono(9, weight: .bold)).tracking(0.6)
                .foregroundStyle(toolColor(tag))
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background(toolColor(tag).opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            VStack(alignment: .leading, spacing: 2) {
                Text(name).font(Fonts.mono(11.5)).foregroundStyle(Tokens.fg)
                Text((input ?? .null).prettyString)
                    .font(Fonts.mono(11.5)).foregroundStyle(Tokens.fgMuted)
                    .lineLimit(6)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Color(hex: 0x0E0E0E))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.borderSoft, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.vertical, 4)
    }

    private func toolResultBubble(text: String, isError: Bool) -> some View {
        HStack(alignment: .top, spacing: 9) {
            Text(isError ? "ERR" : "OK")
                .font(Fonts.mono(9, weight: .bold)).tracking(0.6)
                .foregroundStyle(isError ? Tokens.danger : Tokens.ok)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background((isError ? Tokens.danger : Tokens.ok).opacity(0.10))
                .clipShape(RoundedRectangle(cornerRadius: 4))
            Text(text)
                .font(Fonts.mono(11)).foregroundStyle(Tokens.fgMuted)
                .lineLimit(8)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .background(Color(hex: 0x0C0C0C))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.borderSoft, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func tagFor(name: String) -> String {
        if ["write_file", "edit_file", "create_file", "delete_file"].contains(name) { return "write" }
        if ["bash", "exec", "shell"].contains(name) { return "exec" }
        if ["fetch_url", "web_search", "http_request"].contains(name) { return "net" }
        return "tool"
    }
    private func toolColor(_ tag: String) -> Color {
        switch tag {
        case "write": Tokens.warn; case "exec": Tokens.danger
        case "net":   Tokens.info; default:    Tokens.fgDim
        }
    }

    // MARK: pending approvals banner

    private var pendingApprovalBanner: some View {
        let count = pendingApprovals.count
        return VStack(alignment: .leading, spacing: 10) {
            Text("APPROVAL REQUIRED · \(count) PENDING")
                .font(Fonts.mono(10, weight: .bold)).tracking(1)
                .foregroundStyle(Tokens.warn)
            Text("\(state.branding.agentName.capitalized) wants to run \(count) tool call\(count == 1 ? "" : "s") that need a decision.")
                .font(.system(size: 13.5, weight: .medium))
                .foregroundStyle(Tokens.fg)
            SqButton(title: "Review & decide", style: .warn,
                     fullWidth: true, height: 44) { go(.approvals) }
        }
        .padding(14)
        .background(LinearGradient(colors: [Tokens.warn.opacity(0.10), Tokens.warn.opacity(0.02)],
                                   startPoint: .top, endPoint: .bottom))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tokens.warn.opacity(0.35), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .padding(.vertical, 8)
    }
}

// MARK: - Header

private struct ChatHeader: View {
    let session: SessionRecord?
    let sessionId: String
    let subagentBadge: Int
    var onBack: () -> Void
    var onSubagents: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            IconButton(icon: "chevron.left", action: onBack)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    if let plat = session?.platform { ChannelChip(channel: Channel(plat)) }
                    if session?.isStreaming == true { Pulse() }
                    Mono(String(sessionId.prefix(10)), size: 10, color: Tokens.fgDim)
                }
                Text(session?.displayTitle ?? "Session")
                    .font(.system(size: 13.5, weight: .semibold))
                    .foregroundStyle(Tokens.fg)
                    .lineLimit(1)
            }
            Spacer()
            IconButton(
                icon: "point.3.connected.trianglepath.dotted",
                badge: subagentBadge > 0 ? "\(subagentBadge)" : nil,
                badgeColor: Tokens.magenta,
                action: onSubagents
            )
        }
        .padding(.horizontal, 12)
        .frame(height: 54)
        .background(LinearGradient(colors: [
            Tokens.bg.opacity(0.95), Tokens.bg.opacity(0.7), Tokens.bg.opacity(0)
        ], startPoint: .top, endPoint: .bottom))
        .padding(.top, 0)
    }
}

// MARK: - Composer

private struct Composer: View {
    @Binding var text: String
    var sending: Bool
    var placeholder: String
    var onSend: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "plus")
                .font(.system(size: 18))
                .foregroundStyle(Tokens.fgMuted)
                .frame(width: 36, height: 36)
            TextField("", text: $text, prompt: Text(placeholder).foregroundColor(Tokens.fgDim),
                      axis: .vertical)
                .lineLimit(1...5)
                .font(.system(size: 14))
                .foregroundStyle(Tokens.fg)
                .padding(.horizontal, 16).frame(minHeight: 44)
                .background(Tokens.bgElevated)
                .overlay(RoundedRectangle(cornerRadius: 22).stroke(Tokens.border, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 22))
            Button(action: onSend) {
                Image(systemName: sending ? "ellipsis" : "arrow.up")
                    .font(.system(size: 16, weight: .bold))
                    .foregroundStyle(.white)
                    .frame(width: 44, height: 44)
                    .background(Tokens.accent.opacity(text.isEmpty ? 0.4 : 1))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(text.isEmpty || sending)
        }
        .padding(.horizontal, 12).padding(.bottom, 28).padding(.top, 10)
        .background(LinearGradient(colors: [Tokens.bg.opacity(0), Tokens.bg.opacity(0.95)],
                                   startPoint: .top, endPoint: .bottom))
    }
}

// MARK: - Typing dots (mirrors the dashboard "thinking…" indicator)

private struct TypingDots: View {
    @State private var phase = 0
    private let timer = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<3, id: \.self) { i in
                Circle()
                    .fill(Tokens.fgMuted)
                    .frame(width: 6, height: 6)
                    .opacity(phase == i ? 1.0 : 0.3)
                    .animation(.easeInOut(duration: 0.3), value: phase)
            }
        }
        .padding(.vertical, 4)
        .onReceive(timer) { _ in phase = (phase + 1) % 3 }
    }
}

// MARK: - Bubble shape

struct BubbleShape: Shape {
    enum Role { case user, agent }
    let role: Role
    func path(in rect: CGRect) -> Path {
        let r: CGFloat = 18
        let small: CGFloat = 4
        switch role {
        case .user:
            return Path(roundedRect: rect, cornerRadii: .init(
                topLeading: r, bottomLeading: r, bottomTrailing: small, topTrailing: r
            ), style: .continuous)
        case .agent:
            return Path(roundedRect: rect, cornerRadii: .init(
                topLeading: r, bottomLeading: small, bottomTrailing: r, topTrailing: r
            ), style: .continuous)
        }
    }
}
