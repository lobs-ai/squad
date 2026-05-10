import SwiftUI

// FTS-backed search. Calls session.search on every keystroke (debounced).
// We intentionally don't cache previous queries — the gateway is fast enough.

struct SearchView: View {
    @EnvironmentObject var state: AppState
    var go: (NavigationIntent) -> Void

    @State private var query: String = ""
    @State private var hits: [SearchHit] = []
    @State private var elapsedMs: Int = 0
    @State private var debounceTask: Task<Void, Never>?

    var body: some View {
        ZStack {
            Tokens.bg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 0) {
                    Color.clear.frame(height: 110)

                    SectionLabel(
                        title: hits.isEmpty
                            ? (query.isEmpty ? "Type to search" : "No matches")
                            : "\(hits.count) match\(hits.count == 1 ? "" : "es")",
                        trailing: hits.isEmpty ? nil : "\(elapsedMs) ms"
                    )

                    CardView {
                        if hits.isEmpty {
                            CardRow(isLast: true) {
                                Text(query.isEmpty
                                     ? "Search across every session, transcript and tool call."
                                     : "Nothing matches “\(query)”.")
                                    .font(.system(size: 13))
                                    .foregroundStyle(Tokens.fgDim)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        } else {
                            ForEach(Array(hits.enumerated()), id: \.element.id) { i, h in
                                Button {
                                    go(.chat(h.sessionId))
                                } label: {
                                    CardRow(isLast: i == hits.count - 1) {
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack(spacing: 6) {
                                                Text("MATCH")
                                                    .font(Fonts.mono(9, weight: .bold))
                                                    .tracking(0.7).foregroundStyle(Tokens.fgMuted)
                                                    .padding(.horizontal, 6).padding(.vertical, 2)
                                                    .background(Tokens.bgCard)
                                                    .clipShape(RoundedRectangle(cornerRadius: 5))
                                                Mono(String(h.sessionId.prefix(10)),
                                                     size: 11, color: Tokens.fgDim)
                                                Spacer()
                                                Text(timeAgo(h.ts)).font(Fonts.mono(11))
                                                    .foregroundStyle(Tokens.fgDim)
                                            }
                                            Text(h.session?.displayTitle ?? "Session")
                                                .font(.system(size: 14, weight: .medium))
                                                .foregroundStyle(Tokens.fg)
                                            Text(h.snippet)
                                                .font(Fonts.mono(12))
                                                .foregroundStyle(Tokens.fgMuted)
                                                .padding(.horizontal, 8).padding(.vertical, 6)
                                                .frame(maxWidth: .infinity, alignment: .leading)
                                                .background(Tokens.bgCard)
                                                .overlay(Rectangle().fill(Tokens.accent).frame(width: 2),
                                                         alignment: .leading)
                                                .clipShape(RoundedRectangle(cornerRadius: 6))
                                                .lineLimit(3)
                                        }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    Color.clear.frame(height: 130)
                }
            }

            // Search header
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    IconButton(icon: "chevron.left", action: { go(.back) })
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(Tokens.fgDim)
                            .font(.system(size: 14))
                        TextField("", text: $query, prompt: Text("Search transcripts, sessions, tools").foregroundColor(Tokens.fgDim))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .foregroundStyle(Tokens.fg)
                            .font(.system(size: 14))
                        Text("FTS5").font(Fonts.mono(10.5))
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
                }
                .padding(.horizontal, 12)
                .frame(height: 54)
                .background(Tokens.bg.opacity(0.92))
                Spacer()
            }
        }
        .onChange(of: query) { _, new in scheduleSearch(new) }
    }

    private func scheduleSearch(_ q: String) {
        debounceTask?.cancel()
        debounceTask = Task {
            try? await Task.sleep(nanoseconds: 250_000_000)
            await runSearch(q)
        }
    }
    private func runSearch(_ q: String) async {
        let trimmed = q.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { hits = []; return }
        let started = Date()
        do {
            hits = try await state.client.searchSessions(query: trimmed, limit: 30)
            elapsedMs = Int(Date().timeIntervalSince(started) * 1000)
        } catch {
            hits = []
        }
    }
}
