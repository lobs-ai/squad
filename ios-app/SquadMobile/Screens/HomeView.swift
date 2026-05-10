import SwiftUI

// Overview screen — pending questions hero card, approvals row, live counters,
// recent activity. All data driven by AppState (no mock).

struct HomeView: View {
    @EnvironmentObject var state: AppState
    var go: (NavigationIntent) -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 110)    // pad under topbar (54 status + 56 bar)

                PageHeader(
                    title: "Overview",
                    subtitle: HStack(spacing: 6) {
                        Text("Right now,").foregroundStyle(Tokens.fgMuted)
                        Mono(state.allSquadsMode
                             ? "\(max(state.paired.count, 1)) squads"
                             : (state.activeSquad?.name ?? "—"),
                             size: 13, color: Tokens.fgMuted)
                    }
                )

                // Needs you
                let pending = state.questions.filter { $0.status == "pending" }
                let pendingApprovals = state.approvals.filter { $0.status == "pending" }
                SectionLabel(title: "Needs you",
                             trailing: "\(pending.count + pendingApprovals.count) pending")

                if pending.isEmpty && pendingApprovals.isEmpty {
                    CardView { CardRow(isLast: true) {
                        Image(systemName: "checkmark.circle")
                            .foregroundStyle(Tokens.ok).font(.system(size: 18))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("All clear").font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Tokens.fg)
                            Text("Agents have nothing waiting on you.")
                                .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                        }
                        Spacer()
                    }}
                }

                ForEach(pending) { q in
                    QuestionCard(question: q, go: go)
                }

                if !pendingApprovals.isEmpty {
                    CardView {
                        ForEach(Array(pendingApprovals.prefix(2).enumerated()), id: \.element.id) { idx, a in
                            Button { go(.approvals) } label: {
                                CardRow(isLast: idx == min(pendingApprovals.count, 2) - 1) {
                                    ApprovalTag(tag: a.primaryTag)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(approvalSummary(a))
                                            .font(.system(size: 13.5, weight: .medium))
                                            .foregroundStyle(Tokens.fg).lineLimit(2)
                                        HStack(spacing: 6) {
                                            Text(a.toolName)
                                            Text("·").foregroundStyle(Tokens.fgDim)
                                            Mono(state.activeSquad?.name ?? "squad", size: 11, color: Tokens.fgDim)
                                        }
                                        .font(Fonts.mono(11))
                                        .foregroundStyle(Tokens.fgDim)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 12, weight: .bold))
                                        .foregroundStyle(Tokens.fgDim)
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                // Active work counters
                SectionLabel(title: "Active work", trailing: liveCountersTrailing)
                CardView {
                    CardRow {
                        Stat(label: "Sessions streaming", value: "\(streamingCount)", live: streamingCount > 0)
                        Stat(label: "Questions", value: "\(state.questions.filter { $0.status == "pending" }.count)")
                    }
                    CardRow(isLast: true) {
                        Stat(label: "Tasks in-progress", value: "\(state.tasks.filter { $0.status == "in_progress" }.count)")
                        Stat(label: "Approvals", value: "\(state.approvals.filter { $0.status == "pending" }.count)")
                    }
                }

                // Recent sessions
                SectionLabel(title: "Recent sessions", trailing: "\(state.sessions.count) total")
                CardView {
                    let recent = state.sessions.prefix(5)
                    if recent.isEmpty {
                        CardRow(isLast: true) {
                            Text("No sessions yet — spawn one with the + button.")
                                .font(.system(size: 12))
                                .foregroundStyle(Tokens.fgDim)
                        }
                    } else {
                        ForEach(Array(recent.enumerated()), id: \.element.id) { i, s in
                            Button { go(.chat(s.id)) } label: {
                                CardRow(isLast: i == recent.count - 1) {
                                    SessionRowBody(session: s)
                                    Image(systemName: "chevron.right")
                                        .foregroundStyle(Tokens.fgDim)
                                        .font(.system(size: 12, weight: .bold))
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }

                Color.clear.frame(height: 110)    // pad above tab dock
            }
        }
        .scrollIndicators(.hidden)
        .refreshable { await state.refreshAll() }
    }

    private var streamingCount: Int { state.sessions.filter { $0.isStreaming }.count }
    private var liveCountersTrailing: String { streamingCount > 0 ? "streaming · live" : "idle" }

    private func approvalSummary(_ a: ApprovalRecord) -> String {
        if let obj = a.input?.objectValue {
            if let path = obj["path"]?.stringValue { return "\(a.toolName) \(path)" }
            if let cmd = obj["command"]?.stringValue { return cmd }
            if let url = obj["url"]?.stringValue { return url }
        }
        return a.toolName
    }
}

// MARK: - Question card

struct QuestionCard: View {
    @EnvironmentObject var state: AppState
    let question: QuestionRecord
    var go: (NavigationIntent) -> Void

    @State private var sending: String?     // option key being sent

    var body: some View {
        let q = question.input.questions.first
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.system(size: 11, weight: .bold))
                Text("Question · ")
                + Text(question.askedBy ?? "agent").font(Fonts.mono(10, weight: .bold))
                + Text(" · \(timeAgo(question.askedAt))")
            }
            .font(Fonts.mono(10, weight: .bold))
            .tracking(1)
            .foregroundStyle(Tokens.accent)

            Text(q?.question ?? "Question")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Tokens.fg)
                .padding(.top, 6).padding(.bottom, 14)

            VStack(spacing: 6) {
                if let q {
                    ForEach(Array(q.options.enumerated()), id: \.offset) { idx, opt in
                        let key = optionKey(idx)
                        Button { send(key: key) } label: {
                            HStack(spacing: 10) {
                                Text(key)
                                    .font(Fonts.mono(11, weight: .semibold))
                                    .foregroundStyle(sending == key ? .white : Tokens.fgMuted)
                                    .frame(width: 22, height: 22)
                                    .background(sending == key ? Tokens.accent : Tokens.bg)
                                    .overlay(RoundedRectangle(cornerRadius: 6)
                                        .stroke(sending == key ? Tokens.accent : Tokens.border, lineWidth: 1))
                                    .clipShape(RoundedRectangle(cornerRadius: 6))
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(opt.label).font(.system(size: 14, weight: .medium))
                                        .foregroundStyle(Tokens.fg).multilineTextAlignment(.leading)
                                    if let d = opt.description, !d.isEmpty {
                                        Text(d).font(Fonts.mono(11)).foregroundStyle(Tokens.fgDim)
                                            .multilineTextAlignment(.leading)
                                    }
                                }
                                Spacer()
                            }
                            .padding(.horizontal, 14).padding(.vertical, 12)
                            .background(sending == key ? Tokens.accentSoft : Tokens.bgElevated)
                            .overlay(RoundedRectangle(cornerRadius: 10)
                                .stroke(sending == key ? Tokens.accent : Tokens.border, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                        .disabled(sending != nil)
                    }
                }
            }

            Button { go(.chat(question.sessionId)) } label: {
                HStack(spacing: 6) {
                    Text("Open the session for context")
                    Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold))
                }
                .font(.system(size: 12)).foregroundStyle(Tokens.fgMuted)
                .padding(.top, 12)
            }
            .buttonStyle(.plain)
        }
        .padding(16)
        .background(LinearGradient(colors: [
            Tokens.accent.opacity(0.10), Tokens.accent.opacity(0.02)
        ], startPoint: .top, endPoint: .bottom))
        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Tokens.accentLine, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private func optionKey(_ idx: Int) -> String {
        if let scalar = UnicodeScalar(65 + idx) { return String(Character(scalar)) }
        return "\(idx + 1)"
    }

    private func send(key: String) {
        sending = key
        Task {
            do {
                let answers = ["q0": key]    // server stores answers keyed by question idx
                try await state.client.answerQuestion(
                    sessionId: question.sessionId,
                    questionId: question.id,
                    answers: answers
                )
                go(.toast("Answer sent"))
                await state.refreshQuestions()
            } catch {
                go(.toast("send failed: \(error.localizedDescription)"))
                sending = nil
            }
        }
    }
}

// Approval tag chip (write/exec/network)
struct ApprovalTag: View {
    let tag: String
    var body: some View {
        Text(tag.uppercased())
            .font(Fonts.mono(9, weight: .bold))
            .tracking(0.7)
            .foregroundStyle(color)
            .frame(width: 32, height: 32)
            .background(color.opacity(0.14))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
    private var color: Color {
        switch tag.lowercased() {
        case "write": Tokens.warn
        case "exec":  Tokens.danger
        case "network", "net": Tokens.info
        default:      Tokens.fgMuted
        }
    }
}

// Stat (column) inside cards.
struct Stat: View {
    let label: String
    let value: String
    var live: Bool = false
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.system(size: 13)).foregroundStyle(Tokens.fgMuted)
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(value)
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(Tokens.fg)
                if live { Pulse() }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// Compact session row body — channel chip, id, title, model+last update.
struct SessionRowBody: View {
    @EnvironmentObject var state: AppState
    let session: SessionRecord
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                ChannelChip(channel: Channel(session.platform))
                Mono(String(session.id.prefix(8)), size: 10, color: Tokens.fgDim)
                if session.isStreaming { Pulse() }
                if hasQuestion { tagPill("question", color: Tokens.accent) }
                if hasApproval { tagPill("approval", color: Tokens.warn) }
            }
            Text(session.displayTitle)
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(Tokens.fg)
                .lineLimit(2)
            Text(metaLine)
                .font(Fonts.mono(11))
                .foregroundStyle(Tokens.fgDim)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    private var hasQuestion: Bool { state.questions.contains { $0.sessionId == session.id && $0.status == "pending" } }
    private var hasApproval: Bool { state.approvals.contains { $0.sessionId == session.id && $0.status == "pending" } }
    private var metaLine: String {
        var parts: [String] = [session.model]
        if let updated = session.updatedAt { parts.append("updated \(timeAgo(updated))") }
        if let tin = session.tokensIn, let tout = session.tokensOut, tin + tout > 0 {
            parts.append("\(tin + tout) tok")
        }
        return parts.joined(separator: " · ")
    }
    private func tagPill(_ text: String, color: Color) -> some View {
        Text("· \(text.uppercased())")
            .font(.system(size: 10, weight: .bold))
            .tracking(0.6).foregroundStyle(color)
    }
}

// MARK: - timeAgo helper

func timeAgo(_ iso: String?) -> String {
    guard let iso, let d = iso8601(iso) else { return "—" }
    let s = Int(Date().timeIntervalSince(d))
    if s < 60 { return "\(max(s, 0))s ago" }
    if s < 3600 { return "\(s/60)m ago" }
    if s < 86_400 { return "\(s/3600)h ago" }
    return "\(s/86_400)d ago"
}
func iso8601(_ s: String) -> Date? {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
}
