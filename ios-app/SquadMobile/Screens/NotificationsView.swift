import SwiftUI

// "Notifications" is a chronological feed of recent gateway events.
// We assemble it from the live caches (questions, approvals, sessions).
// No mock data — if those caches are empty, the feed is empty.

struct NotificationsView: View {
    @EnvironmentObject var state: AppState
    var go: (NavigationIntent) -> Void
    @State private var quietHours = false

    var body: some View {
        ZStack {
            Tokens.bg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 0) {
                    Color.clear.frame(height: 110)

                    SectionLabel(title: "Today")
                    CardView {
                        let entries = recent
                        if entries.isEmpty {
                            CardRow(isLast: true) {
                                Text("No notifications yet — they'll show up here as the agents work.")
                                    .font(.system(size: 13)).foregroundStyle(Tokens.fgDim)
                            }
                        } else {
                            ForEach(Array(entries.enumerated()), id: \.element.id) { i, e in
                                Button { e.intent.flatMap(go) } label: {
                                    CardRow(isLast: i == entries.count - 1) {
                                        Image(systemName: e.symbol)
                                            .font(.system(size: 14))
                                            .foregroundStyle(e.color)
                                            .frame(width: 32, height: 32)
                                            .background(Tokens.bgCard)
                                            .clipShape(RoundedRectangle(cornerRadius: 8))
                                        VStack(alignment: .leading, spacing: 1) {
                                            Text(e.title).font(Fonts.mono(12)).foregroundStyle(Tokens.fgMuted)
                                            Text(e.body).font(.system(size: 13.5, weight: .medium))
                                                .foregroundStyle(Tokens.fg).lineLimit(2)
                                        }
                                        Spacer()
                                        Text(timeAgo(e.when))
                                            .font(Fonts.mono(11)).foregroundStyle(Tokens.fgDim)
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    SectionLabel(title: "Quiet hours")
                    CardView {
                        CardRow(isLast: true) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("22:00 → 08:00").font(.system(size: 14)).foregroundStyle(Tokens.fg)
                                Text("Only critical approvals break through")
                                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                            SqToggle(on: $quietHours)
                        }
                    }

                    Color.clear.frame(height: 130)
                }
            }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    IconButton(icon: "chevron.left", action: { go(.back) })
                    Text("Notifications").font(.system(size: 16, weight: .bold))
                        .foregroundStyle(Tokens.fg)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .frame(height: 54)
                .background(Tokens.bg.opacity(0.92))
                Spacer()
            }
        }
    }

    // Synthesise recent feed entries from cache.
    struct Entry: Identifiable {
        let id: String; let symbol: String; let color: Color
        let title: String; let body: String; let when: String?
        let intent: NavigationIntent?
    }

    private var recent: [Entry] {
        var out: [Entry] = []
        for q in state.questions.prefix(8) {
            out.append(Entry(
                id: "q-\(q.id)", symbol: "sparkles", color: Tokens.accent,
                title: "Question · \(state.activeSquad?.name ?? "squad")",
                body: q.input.questions.first?.question ?? "Ask user",
                when: q.askedAt, intent: .chat(q.sessionId)
            ))
        }
        for a in state.approvals.prefix(8) {
            out.append(Entry(
                id: "a-\(a.id)", symbol: "checkmark.shield", color: Tokens.warn,
                title: "Approval · \(state.activeSquad?.name ?? "squad")",
                body: a.toolName,
                when: a.createdAt, intent: .approvals
            ))
        }
        for s in state.sessions.prefix(8) {
            out.append(Entry(
                id: "s-\(s.id)", symbol: "message", color: Tokens.info,
                title: "Session · \(state.activeSquad?.name ?? "squad")",
                body: s.displayTitle,
                when: s.updatedAt, intent: .chat(s.id)
            ))
        }
        return out.sorted { ($0.when ?? "") > ($1.when ?? "") }
    }
}
