import SwiftUI

struct StepWelcome: View {
    let step: Int
    let total: Int
    var onNext: () -> Void

    var body: some View {
        StepShell(
            kicker: "Squad Mobile",
            title: "Run agents from your phone.",
            sub: "Watch sessions stream live, answer questions, approve tool calls, and spawn new work — all wired into the squad running on your dev box.",
            primary: "Get started",
            secondary: nil,
            step: step, total: total,
            onPrimary: onNext
        ) {
            VStack(spacing: 10) {
                Bullet(symbol: "sparkles",   title: "Answer ask-user questions", desc: "Reply right from the lock screen.")
                Bullet(symbol: "checkmark.shield", title: "Gate writes & exec", desc: "Approve or reject every risky tool call.")
                Bullet(symbol: "message",    title: "Stream sessions live",      desc: "Tail tool calls, costs, and outputs as they happen.")
                Bullet(symbol: "point.3.connected.trianglepath.dotted", title: "Spawn squads & subagents", desc: "Start new work without opening the laptop.")
            }
            .padding(.top, 8)
        }
    }
}

private struct Bullet: View {
    let symbol: String
    let title: String
    let desc: String
    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: symbol)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(Tokens.accent)
                .frame(width: 32, height: 32)
                .background(Tokens.accentSoft)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Tokens.fg)
                Text(desc).font(.system(size: 12.5)).foregroundStyle(Tokens.fgMuted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 12)
        .background(Color.white.opacity(0.03))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.06), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}
