import SwiftUI

// Step 1 — pick how the phone reaches the squad. Three modes; each has its own
// helper text + URL examples. Default port 8080 is the squad gateway default.

struct StepReach: View {
    let step: Int
    let total: Int
    var onNext: () -> Void
    var onBack: () -> Void

    @State private var mode: Mode = .tailscale

    enum Mode: String, CaseIterable, Hashable { case tailscale, lan, tunnel
        var label: String {
            switch self { case .tailscale: "Tailscale"; case .lan: "Local network"; case .tunnel: "Cloud tunnel" }
        }
        var hint: String {
            switch self { case .tailscale: "recommended"; case .lan: "same wifi only"; case .tunnel: "cloudflare/ngrok" }
        }
    }

    private let port = 8080

    var body: some View {
        StepShell(
            kicker: "Step 1 · Reach it",
            title: "How will your phone find your squad?",
            sub: "Your squad already runs locally on a port. Tailscale is the recommended path to reach it from anywhere — it works on any network without poking holes in your firewall.",
            primary: "Continue",
            secondary: "Back",
            step: step, total: total,
            onPrimary: onNext, onSecondary: onBack
        ) {
            HStack(spacing: 8) {
                ForEach(Mode.allCases, id: \.self) { m in
                    Button { mode = m } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(m.label).font(.system(size: 12.5, weight: .semibold))
                                .foregroundStyle(mode == m ? Tokens.fg : Tokens.fgMuted)
                            Text(m.hint).font(Fonts.mono(10))
                                .foregroundStyle(Tokens.fgDim)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 8).padding(.vertical, 10)
                        .background(mode == m ? Tokens.accentSoft : Color.white.opacity(0.03))
                        .overlay(RoundedRectangle(cornerRadius: 10)
                            .stroke(mode == m ? Tokens.accentLine : Color.white.opacity(0.06), lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.bottom, 14)

            switch mode {
            case .tailscale: tailscaleHelp
            case .lan:       lanHelp
            case .tunnel:    tunnelHelp
            }
        }
    }

    private var tailscaleHelp: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("On your dev box and on this phone, install Tailscale and sign into the same tailnet. Both devices then get a stable address.")
                .font(.system(size: 13))
                .foregroundStyle(Tokens.fgMuted)

            CodeBlock(text: "$ tailscale status\n  100.84.12.7   your-mbp\n  100.121.4.19  iphone-16")

            Text("Your URL will look like one of these:")
                .font(.system(size: 13)).foregroundStyle(Tokens.fgMuted)

            ForEach([
                "https://your-mbp.tail-scale.ts.net:\(port)",
                "https://your-mbp:\(port)",
                "http://100.84.12.7:\(port)",
            ], id: \.self) { url in
                Text(url)
                    .font(Fonts.mono(12))
                    .foregroundStyle(Tokens.fg)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.white.opacity(0.03))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.06), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    private var lanHelp: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Find your dev box's LAN IP and use it directly. Phone and machine must be on the same network.")
                .font(.system(size: 13)).foregroundStyle(Tokens.fgMuted)
            CodeBlock(text: "# macOS\n$ ipconfig getifaddr en0\n  192.168.1.42\n\n# linux\n$ hostname -I | awk '{print $1}'")
            Text("http://192.168.1.42:\(port)")
                .font(Fonts.mono(12))
                .foregroundStyle(Tokens.fg)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 8)
                .background(Color.white.opacity(0.03))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.06), lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
    }

    private var tunnelHelp: some View {
        VStack(alignment: .leading, spacing: 10) {
            (Text("Expose ") + Text(":\(port)").font(Fonts.mono(13)).foregroundColor(Tokens.fg) +
             Text(" through a tunnel. The tunnel URL becomes your squad URL."))
                .font(.system(size: 13))
                .foregroundStyle(Tokens.fgMuted)
            CodeBlock(text: "$ cloudflared tunnel --url http://localhost:\(port)\n  https://wandering-frog-42.trycloudflare.com\n\n# or\n$ ngrok http \(port)")
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.shield")
                    .foregroundStyle(Tokens.warn)
                    .font(.system(size: 14, weight: .semibold))
                    .padding(.top, 1)
                Text("Tunnels expose your squad to the public internet. The pairing code on the next step is your only auth — keep it private.")
                    .font(.system(size: 12.5))
                    .foregroundStyle(Tokens.fgMuted)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 11)
            .background(Tokens.warn.opacity(0.07))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.warn.opacity(0.22), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}
