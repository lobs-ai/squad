import SwiftUI
import UserNotifications

// Local key for each toggle row. Initial defaults match the design — questions
// and approvals on (loud), reports/completions on (banner), cost alerts off.
private enum NotifKind: String, CaseIterable, Hashable {
    case questions, approvals, subagents, completions, costs
    var symbol: String {
        switch self {
        case .questions:   "sparkles"
        case .approvals:   "checkmark.shield"
        case .subagents:   "point.3.connected.trianglepath.dotted"
        case .completions: "checkmark.circle"
        case .costs:       "clock"
        }
    }
    var title: String {
        switch self {
        case .questions:   "Questions"
        case .approvals:   "Approval requests"
        case .subagents:   "Subagent reports"
        case .completions: "Session completions"
        case .costs:       "Cost / budget alerts"
        }
    }
    var desc: String {
        switch self {
        case .questions, .approvals: "High priority — wakes the screen."
        case .subagents, .completions: "Banner only."
        case .costs: "Silent."
        }
    }
    var defaultOn: Bool { self != .costs }
}

struct StepNotifs: View {
    let step: Int
    let total: Int
    var onNext: () -> Void
    var onBack: () -> Void

    @State private var granted = false
    @State private var requested = false
    @State private var enabled: [NotifKind: Bool] = Dictionary(
        uniqueKeysWithValues: NotifKind.allCases.map { ($0, $0.defaultOn) }
    )

    var body: some View {
        StepShell(
            kicker: "Step 3 · Notifications",
            title: "Get pinged when agents need you.",
            sub: "Push handles questions, approval requests, subagent reports, and session completions. You can fine-tune which fire as a banner vs. silent in Settings.",
            primary: granted ? "Continue" : (requested ? "Continue" : "Allow notifications"),
            secondary: granted ? "Back" : "Not now",
            step: step, total: total,
            onPrimary: {
                if granted || requested { onNext(); return }
                requestPermission()
            },
            onSecondary: {
                if granted { onBack() } else { onNext() }
            }
        ) {
            VStack(spacing: 8) {
                ForEach(NotifKind.allCases, id: \.self) { kind in
                    NotifRow(
                        symbol: kind.symbol,
                        title: kind.title,
                        desc: kind.desc,
                        on: Binding(
                            get: { enabled[kind] ?? false },
                            set: { enabled[kind] = $0 }
                        )
                    )
                }
            }

            if granted {
                HStack(spacing: 10) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(Tokens.ok)
                    Text("Notifications enabled.").font(.system(size: 13)).foregroundStyle(Tokens.ok)
                }
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(Tokens.ok.opacity(0.08))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.ok.opacity(0.25), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.top, 14)
            }
        }
    }

    private func requestPermission() {
        Task {
            do {
                let ok = try await UNUserNotificationCenter.current()
                    .requestAuthorization(options: [.alert, .sound, .badge])
                self.granted = ok
                self.requested = true
            } catch {
                self.requested = true
            }
        }
    }
}

private struct NotifRow: View {
    let symbol: String
    let title: String
    let desc: String
    @Binding var on: Bool

    var body: some View {
        Button { withAnimation(.spring(response: 0.25, dampingFraction: 0.85)) { on.toggle() } } label: {
            HStack(spacing: 12) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(on ? Tokens.accent : Tokens.fgMuted)
                    .frame(width: 28, height: 28)
                    .background(on ? Tokens.accentSoft : Color.white.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).font(.system(size: 13.5, weight: .semibold))
                        .foregroundStyle(Tokens.fg)
                    Text(desc).font(.system(size: 11.5))
                        .foregroundStyle(Tokens.fgDim)
                }
                Spacer()
                ZStack(alignment: on ? .trailing : .leading) {
                    Capsule().fill(on ? Tokens.accent : Color.white.opacity(0.12))
                        .frame(width: 32, height: 20)
                    Circle().fill(.white).frame(width: 16, height: 16).padding(2)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Color.white.opacity(0.03))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.06), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}
