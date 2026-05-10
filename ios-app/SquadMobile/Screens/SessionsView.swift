import SwiftUI

struct SessionsView: View {
    @EnvironmentObject var state: AppState
    var go: (NavigationIntent) -> Void
    @State private var scope: Scope = .all

    enum Scope: Hashable, CaseIterable { case all, streaming, waiting, mine
        var label: String {
            switch self { case .all: "All"; case .streaming: "Streaming"; case .waiting: "Waiting"; case .mine: "Mine" }
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 110)

                PageHeader(
                    title: "Sessions",
                    subtitle: HStack(spacing: 4) {
                        Mono("\(state.sessions.count) active", size: 13, color: Tokens.fgMuted)
                    }
                )

                // Search shortcut
                Button { go(.search) } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass")
                            .font(.system(size: 14)).foregroundStyle(Tokens.fgDim)
                        Text("Search sessions, tasks, transcripts")
                            .font(.system(size: 14)).foregroundStyle(Tokens.fgDim)
                        Spacer()
                        Text("FTS").font(Fonts.mono(10.5))
                            .foregroundStyle(Tokens.fgMuted)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Tokens.bgCard)
                            .overlay(RoundedRectangle(cornerRadius: 4).stroke(Tokens.borderSoft, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                    .padding(.horizontal, 12).frame(height: 40)
                    .background(Tokens.bgElevated)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.borderSoft, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.horizontal, 16).padding(.top, 8)
                }
                .buttonStyle(.plain)

                SegControl(items: Scope.allCases.map { ($0, $0.label, nil) },
                           selection: $scope)
                .padding(.top, 4)

                CardView {
                    let filtered = filtered()
                    if filtered.isEmpty {
                        CardRow(isLast: true) {
                            Text("Nothing here. Pull down to refresh.")
                                .font(.system(size: 13))
                                .foregroundStyle(Tokens.fgDim)
                                .frame(maxWidth: .infinity, alignment: .center)
                                .padding(.vertical, 14)
                        }
                    } else {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { i, s in
                            Button { go(.chat(s.id)) } label: {
                                CardRow(isLast: i == filtered.count - 1) {
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

                Color.clear.frame(height: 130)
            }
        }
        .scrollIndicators(.hidden)
        .refreshable { await state.refreshAll() }
    }

    private func filtered() -> [SessionRecord] {
        let topLevel = state.sessions.filter { $0.parentSessionId == nil }
        switch scope {
        case .all:       return topLevel
        case .streaming: return topLevel.filter { $0.isStreaming }
        case .waiting:
            let q = Set(state.questions.filter { $0.status == "pending" }.map(\.sessionId))
            let a = Set(state.approvals.filter { $0.status == "pending" }.map(\.sessionId))
            let waiting = q.union(a)
            return topLevel.filter { waiting.contains($0.id) }
        case .mine:
            // No multi-user concept yet — treat "mine" as sessions started from this device
            // (no remote platform), which is the closest signal we have.
            return topLevel.filter { ($0.platform ?? "").isEmpty || $0.platform == "mobile" }
        }
    }
}
