import SwiftUI

struct MoreView: View {
    @EnvironmentObject var state: AppState
    var go: (NavigationIntent) -> Void

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 110)

                PageHeader(
                    title: "More",
                    subtitle: Text("Search, squad health, settings")
                        .foregroundStyle(Tokens.fgMuted)
                )

                CardView {
                    Button { go(.search) } label: {
                        CardRow {
                            Image(systemName: "magnifyingglass")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(Tokens.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Search everything").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Tokens.fg)
                                Text("Sessions · transcripts · tasks · subagents")
                                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                            chev
                        }
                    }
                    .buttonStyle(.plain)

                    Button { go(.squads) } label: {
                        CardRow {
                            Image(systemName: "power")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(Tokens.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Squad health").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Tokens.fg)
                                Text(squadHealthSummary)
                                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                            chev
                        }
                    }
                    .buttonStyle(.plain)

                    Button { go(.notifications) } label: {
                        CardRow(isLast: true) {
                            Image(systemName: "bell")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundStyle(Tokens.accent)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Notifications").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Tokens.fg)
                                Text("Per-squad rules · quiet hours")
                                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                            chev
                        }
                    }
                    .buttonStyle(.plain)
                }

                if let id = state.identity {
                    SectionLabel(title: "This squad")
                    CardView {
                        CardRow {
                            VStack(alignment: .leading, spacing: 2) {
                                Mono(id.name, size: 14, weight: .semibold)
                                Text("port \(id.port) · build \(id.build ?? "—")")
                                    .font(Fonts.mono(11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                            StatusDot(state: .ok)
                        }
                        if let url = state.activeSquad?.url {
                            CardRow(isLast: true) {
                                Image(systemName: "network").foregroundStyle(Tokens.fgMuted)
                                Text(url).font(Fonts.mono(11)).foregroundStyle(Tokens.fgDim)
                                    .lineLimit(1).truncationMode(.middle)
                                Spacer()
                            }
                        }
                    }
                }

                SectionLabel(title: "Live counts")
                CardView {
                    CardRow(isLast: true) {
                        Stat(label: "Sessions", value: "\(state.sessions.count)")
                        Stat(label: "Tasks", value: "\(state.tasks.count)")
                        Stat(label: "Approvals", value: "\(state.approvals.filter{$0.status=="pending"}.count)")
                    }
                }

                SectionLabel(title: "Account")
                CardView {
                    Button {
                        if let id = state.activeSquad?.id { state.removePaired(id) }
                    } label: {
                        CardRow {
                            Image(systemName: "rectangle.portrait.and.arrow.right")
                                .foregroundStyle(Tokens.danger)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Forget this squad").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Tokens.fg)
                                Text("Removes the local token · re-pair to reconnect")
                                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)

                    Button { state.resetAll() } label: {
                        CardRow(isLast: true) {
                            Image(systemName: "trash").foregroundStyle(Tokens.danger)
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Reset everything").font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Tokens.fg)
                                Text("Forget all squads and tokens")
                                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                            }
                            Spacer()
                        }
                    }
                    .buttonStyle(.plain)
                }

                Color.clear.frame(height: 130)
            }
        }
        .scrollIndicators(.hidden)
    }

    private var chev: some View {
        Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold))
            .foregroundStyle(Tokens.fgDim)
    }
    private var squadHealthSummary: String {
        let healthy = state.peers.filter { $0.status == "healthy" }.count
        let total = max(state.peers.count, 1)
        return "\(total) squad\(total == 1 ? "" : "s") · \(healthy) healthy"
    }
}
