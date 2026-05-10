import SwiftUI

struct SquadsView: View {
    @EnvironmentObject var state: AppState
    var go: (NavigationIntent) -> Void

    var body: some View {
        ZStack {
            Tokens.bg.ignoresSafeArea()
            ScrollView {
                VStack(spacing: 0) {
                    Color.clear.frame(height: 110)

                    PageHeader(
                        title: "Squad health",
                        subtitle: HStack(spacing: 4) {
                            Mono("\(state.peers.count) squad\(state.peers.count == 1 ? "" : "s")",
                                 size: 13, color: Tokens.fgMuted)
                            Text("· \(healthyCount) healthy")
                                .foregroundStyle(Tokens.fgMuted)
                        }
                    )

                    if state.peers.isEmpty {
                        CardView { CardRow(isLast: true) {
                            VStack(alignment: .leading, spacing: 4) {
                                Text("No peers reported by the gateway")
                                    .font(.system(size: 14, weight: .medium))
                                    .foregroundStyle(Tokens.fg)
                                Text("This view shows sibling squads from `admin.peers`. If you only run one squad, this list will stay empty.")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Tokens.fgDim)
                            }
                        }}
                    } else {
                        CardView {
                            ForEach(Array(state.peers.enumerated()), id: \.element.id) { i, p in
                                CardRow(isLast: i == state.peers.count - 1) {
                                    StatusDot(state: peerDot(p.status))
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack(spacing: 6) {
                                            Mono(p.name, size: 14, weight: .semibold)
                                            if let port = p.port {
                                                Mono(":\(port)", size: 11, color: Tokens.fgDim)
                                            }
                                        }
                                        Text("\(p.status) · build \(p.build ?? "—")")
                                            .font(Fonts.mono(11))
                                            .foregroundStyle(Tokens.fgDim)
                                    }
                                    Spacer()
                                }
                            }
                        }
                    }

                    SectionLabel(title: "This phone has tokens for")
                    CardView {
                        ForEach(Array(state.paired.enumerated()), id: \.element.id) { i, sq in
                            Button { state.switchTo(sq); go(.back) } label: {
                                CardRow(isLast: i == state.paired.count - 1) {
                                    Image(systemName: state.activeSquad?.id == sq.id
                                          ? "checkmark.circle.fill" : "circle")
                                        .foregroundStyle(state.activeSquad?.id == sq.id ? Tokens.accent : Tokens.fgDim)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Mono(sq.name, size: 14, weight: .semibold)
                                        Text(sq.url).font(Fonts.mono(11))
                                            .foregroundStyle(Tokens.fgDim).lineLimit(1).truncationMode(.middle)
                                    }
                                    Spacer()
                                }
                            }
                            .buttonStyle(.plain)
                        }
                    }

                    Color.clear.frame(height: 130)
                }
            }

            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    IconButton(icon: "chevron.left", action: { go(.back) })
                    Text("Squad health").font(.system(size: 16, weight: .bold))
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

    private var healthyCount: Int { state.peers.filter { $0.status == "healthy" }.count }
    private func peerDot(_ s: String) -> StatusDot.State {
        switch s {
        case "healthy": .ok
        case "starting": .info
        case "stopped": .idle
        case "unhealthy": .danger
        default: .idle
        }
    }
}
