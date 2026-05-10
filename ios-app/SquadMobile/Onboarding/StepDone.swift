import SwiftUI

struct StepDone: View {
    let step: Int
    let total: Int
    var paired: PairedSquad?
    var onFinish: () -> Void

    var body: some View {
        StepShell(
            kicker: "Done",
            title: "You're connected.",
            sub: "Your squad is paired and reporting in.",
            primary: "Open Squad Mobile",
            secondary: nil,
            step: step, total: total,
            onPrimary: onFinish
        ) {
            VStack(spacing: 16) {
                ZStack {
                    Circle()
                        .fill(RadialGradient(colors: [
                            Tokens.accent.opacity(0.35),
                            Tokens.accent.opacity(0.06),
                            .clear,
                        ], center: .topLeading, startRadius: 0, endRadius: 80))
                        .frame(width: 84, height: 84)
                        .overlay(Circle().stroke(Tokens.accent.opacity(0.4), lineWidth: 1))
                        .shadow(color: Tokens.accent.opacity(0.3), radius: 24)
                    Image(systemName: "checkmark")
                        .font(.system(size: 30, weight: .bold))
                        .foregroundStyle(Tokens.accent)
                }
                .padding(.top, 28)

                if let paired {
                    Text(paired.url)
                        .font(Fonts.mono(11))
                        .foregroundStyle(Tokens.fgDim)
                        .lineLimit(1)
                        .truncationMode(.middle)

                    HStack(spacing: 10) {
                        Circle().fill(Tokens.ok).frame(width: 8, height: 8)
                            .shadow(color: Tokens.ok.opacity(0.5), radius: 4)
                        Text(paired.name)
                            .font(.system(size: 13.5, weight: .semibold))
                            .foregroundStyle(Tokens.fg)
                        Spacer()
                        Text("ready")
                            .font(Fonts.mono(11)).foregroundStyle(Tokens.fgDim)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Color.white.opacity(0.03))
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.06), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .padding(.top, 6)
                }
            }
        }
    }
}
