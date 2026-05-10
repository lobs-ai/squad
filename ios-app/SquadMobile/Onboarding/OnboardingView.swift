import SwiftUI

// 5-step onboarding: Welcome → Reach → Connect → Notifs → Done.
// Matches the design's StepShell layout (kicker, title, sub, scrollable body, dots, primary/secondary).

struct OnboardingView: View {
    let onFinish: (PairedSquad) -> Void

    @State private var step: Int = 0
    @State private var connected: PairedSquad?    // produced by StepConnect

    private let total = 5

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(hex: 0x101013), Color(hex: 0x0E0E10)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()

            switch step {
            case 0: StepWelcome(step: step, total: total,
                                onNext: { step = 1 })
            case 1: StepReach(step: step, total: total,
                              onNext: { step = 2 }, onBack: { step = 0 })
            case 2: StepConnect(step: step, total: total,
                                onPaired: { paired in self.connected = paired; self.step = 3 },
                                onBack: { step = 1 })
            case 3: StepNotifs(step: step, total: total,
                               onNext: { step = 4 }, onBack: { step = 2 })
            default:
                StepDone(step: step, total: total,
                         paired: connected,
                         onFinish: {
                             if let connected { onFinish(connected) }
                         })
            }
        }
        .animation(.easeInOut(duration: 0.18), value: step)
    }
}

// Common chrome (kicker, title, sub, body, footer with dots + buttons).
struct StepShell<Body: View>: View {
    let kicker: String
    let title: String
    let sub: String?
    var primary: String
    var secondary: String?
    var step: Int
    var total: Int
    var onPrimary: () -> Void
    var onSecondary: (() -> Void)?
    var primaryDisabled: Bool = false
    @ViewBuilder var content: () -> Body

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    Text(kicker.uppercased())
                        .font(Fonts.mono(10, weight: .bold))
                        .tracking(1.6)
                        .foregroundStyle(Tokens.accent)
                        .padding(.bottom, 12)
                    Text(title)
                        .font(.system(size: 26, weight: .bold))
                        .tracking(-0.5)
                        .foregroundStyle(Tokens.fg)
                    if let sub {
                        Text(sub)
                            .font(.system(size: 14))
                            .foregroundStyle(Tokens.fgMuted)
                            .padding(.top, 8)
                            .padding(.bottom, 22)
                    } else {
                        Spacer().frame(height: 22)
                    }
                    content()
                }
                .padding(.horizontal, 24)
                .padding(.top, 64)
                .padding(.bottom, 24)
            }

            VStack(spacing: 14) {
                OnbDots(step: step, total: total)
                HStack(spacing: 8) {
                    if let secondary {
                        Button(action: { onSecondary?() }) {
                            Text(secondary)
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Tokens.fg)
                                .padding(.horizontal, 18).frame(height: 48)
                                .background(Color.white.opacity(0.04))
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.08), lineWidth: 1))
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                    Button(action: onPrimary) {
                        HStack(spacing: 6) {
                            Text(primary).font(.system(size: 15, weight: .semibold))
                            Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold))
                        }
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity).frame(height: 48)
                        .background(Tokens.accent.opacity(primaryDisabled ? 0.4 : 1))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .shadow(color: Tokens.accent.opacity(0.32), radius: 14, y: 6)
                    }
                    .buttonStyle(.plain)
                    .disabled(primaryDisabled)
                }
            }
            .padding(.horizontal, 24).padding(.bottom, 28)
        }
    }
}

struct OnbDots: View {
    let step: Int
    let total: Int
    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<total, id: \.self) { i in
                Capsule()
                    .fill(i == step ? Tokens.accent : Color.white.opacity(0.16))
                    .frame(width: i == step ? 18 : 6, height: 6)
                    .animation(.spring(response: 0.25, dampingFraction: 0.85), value: step)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct CodeBlock: View {
    let text: String
    @State private var copied = false
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Text(text)
                .font(Fonts.mono(13))
                .foregroundStyle(Tokens.fgMuted)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 12).padding(.horizontal, 14)
                .background(Color(hex: 0x0A0A0C))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.06), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            Button {
                UIPasteboard.general.string = text
                withAnimation { copied = true }
                Task { try? await Task.sleep(nanoseconds: 1_200_000_000); withAnimation { copied = false } }
            } label: {
                Text(copied ? "COPIED" : "COPY")
                    .font(Fonts.mono(10, weight: .semibold))
                    .tracking(0.4)
                    .foregroundStyle(copied ? Tokens.ok : Tokens.fgDim)
                    .padding(.horizontal, 8).padding(.vertical, 4)
                    .background((copied ? Tokens.ok : Color.white).opacity(copied ? 0.16 : 0.06))
                    .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.white.opacity(0.08), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            .buttonStyle(.plain)
            .padding(8)
        }
    }
}
