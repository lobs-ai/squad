import SwiftUI

// Card — matches .sq-card { bg-elevated, 1px border-soft, 12 radius }
struct CardView<Content: View>: View {
    var glow: Bool = false
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Tokens.bgElevated)
            .clipShape(RoundedRectangle(cornerRadius: Tokens.radius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: Tokens.radius, style: .continuous)
                    .stroke(glow ? Tokens.accentLine : Tokens.borderSoft, lineWidth: 1)
            )
            .shadow(color: glow ? Tokens.accentSoft : .clear, radius: 0, x: 0, y: 0)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
    }
}

// One row inside a card; rows are separated by a 1px divider.
struct CardRow<Content: View>: View {
    var isLast: Bool = false
    @ViewBuilder var content: Content
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) { content }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
            if !isLast { Divider().background(Tokens.borderSoft) }
        }
    }
}

// SECTION LABEL — uppercase 11px, fg-muted, with optional right-aligned mono count.
struct SectionLabel: View {
    let title: String
    var trailing: String? = nil
    var body: some View {
        HStack {
            Text(title.uppercased())
                .font(Fonts.ui(11, weight: .semibold))
                .tracking(0.88)              // ≈ 0.08em at 11px
                .foregroundStyle(Tokens.fgMuted)
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(Fonts.mono(11, weight: .medium))
                    .foregroundStyle(Tokens.fgDim)
            }
        }
        .padding(.horizontal, 20).padding(.top, 18).padding(.bottom, 8)
    }
}

// STATUS DOT — same six states the dashboard uses.
struct StatusDot: View {
    enum State { case ok, info, warn, danger, idle }
    let state: State
    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
    }
    private var color: Color {
        switch state {
        case .ok: Tokens.ok
        case .info: Tokens.info
        case .warn: Tokens.warn
        case .danger: Tokens.danger
        case .idle: Tokens.fgDim
        }
    }
}

// PULSE — accent dot with expanding shadow ring.
struct Pulse: View {
    @State private var on = false
    var body: some View {
        Circle()
            .fill(Tokens.accent)
            .frame(width: 7, height: 7)
            .overlay(
                Circle().stroke(Tokens.accent.opacity(on ? 0 : 0.6), lineWidth: 4)
                    .scaleEffect(on ? 2.4 : 1.0)
            )
            .onAppear {
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { on = true }
            }
    }
}

// CHANNEL CHIP
enum Channel: String { case discord, cli, dash, mobile, unknown
    init(_ raw: String?) {
        switch raw {
        case "discord": self = .discord
        case "cli": self = .cli
        case "dash", "dashboard": self = .dash
        case "mobile": self = .mobile
        default: self = .unknown
        }
    }
    var label: String {
        switch self {
        case .discord: "discord"; case .cli: "cli"; case .dash: "dashboard"
        case .mobile: "mobile"; case .unknown: "channel"
        }
    }
    var color: Color {
        switch self {
        case .discord: Tokens.chDiscord; case .cli: Tokens.chCli; case .dash: Tokens.chDash
        case .mobile: Tokens.chMobile; case .unknown: Tokens.fgMuted
        }
    }
}

struct ChannelChip: View {
    let channel: Channel
    var body: some View {
        Text(channel.label)
            .font(Fonts.mono(10, weight: .semibold))
            .padding(.horizontal, 7).padding(.vertical, 2)
            .foregroundStyle(channel.color)
            .background(channel.color.opacity(0.10))
            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .stroke(channel.color.opacity(0.25), lineWidth: 1)
            )
    }
}

// ICON BUTTON — 36×36 circle with optional badge.
struct IconButton: View {
    let icon: String
    var badge: String? = nil
    var badgeColor: Color = Tokens.danger
    var action: () -> Void = {}
    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Tokens.fg)
                    .frame(width: 36, height: 36)
                    .background(Tokens.bgElevated)
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Tokens.border, lineWidth: 1))
                if let badge {
                    Text(badge)
                        .font(.system(size: 10, weight: .bold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(minWidth: 16, minHeight: 16)
                        .background(badgeColor)
                        .clipShape(Capsule())
                        .overlay(Capsule().stroke(Tokens.bg, lineWidth: 2))
                        .offset(x: 4, y: -4)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// PILL — used by the squad switcher button in the topbar.
struct PillButton<Trailing: View>: View {
    let title: String
    var dotColor: Color
    @ViewBuilder var trailing: Trailing
    var action: () -> Void = {}
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Circle().fill(dotColor)
                    .frame(width: 8, height: 8)
                    .shadow(color: dotColor, radius: 4)
                Text(title)
                    .font(Fonts.mono(13, weight: .semibold))
                    .foregroundStyle(Tokens.fg)
                trailing
            }
            .padding(.leading, 10).padding(.trailing, 12)
            .frame(height: 36)
            .background(Tokens.bgElevated)
            .clipShape(Capsule())
            .overlay(Capsule().stroke(Tokens.border, lineWidth: 1))
        }
        .buttonStyle(.plain)
    }
}

// PRIMARY/GHOST/OK/DANGER button — matches .sq-btn variants.
struct SqButton: View {
    enum Style { case primary, ghost, ok, danger, warn }
    let title: String
    var icon: String? = nil
    var style: Style = .primary
    var fullWidth: Bool = true
    var height: CGFloat = 44
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let icon { Image(systemName: icon).font(.system(size: 14, weight: .semibold)) }
                Text(title).font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(fg)
            .frame(maxWidth: fullWidth ? .infinity : nil)
            .frame(height: height)
            .padding(.horizontal, fullWidth ? 0 : 18)
            .background(bg)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(border, lineWidth: style == .ghost ? 1 : 0)
            )
        }
        .buttonStyle(.plain)
    }
    private var bg: Color {
        switch style {
        case .primary: Tokens.accent
        case .ghost:   Tokens.bgElevated
        case .ok:      Tokens.ok
        case .danger:  Tokens.danger
        case .warn:    Tokens.warn
        }
    }
    private var fg: Color {
        switch style {
        case .ghost:  Tokens.fg
        case .warn:   Color(hex: 0x1A1208)
        default:      .white
        }
    }
    private var border: Color { style == .ghost ? Tokens.border : .clear }
}

// SEGMENTED CONTROL — matches .tasks-segctl
struct SegControl<Item: Hashable>: View {
    let items: [(Item, String, Int?)]
    @Binding var selection: Item
    var body: some View {
        HStack(spacing: 4) {
            ForEach(items, id: \.0) { item in
                Button {
                    selection = item.0
                } label: {
                    HStack(spacing: 5) {
                        Text(item.1).font(.system(size: 12, weight: .semibold))
                        if let count = item.2 {
                            Text("\(count)")
                                .font(Fonts.mono(10))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Tokens.bg)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                                .foregroundStyle(Tokens.fgDim)
                        }
                    }
                    .foregroundStyle(selection == item.0 ? Tokens.fg : Tokens.fgMuted)
                    .frame(maxWidth: .infinity)
                    .frame(height: 32)
                    .background(selection == item.0 ? Tokens.bgCard : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(Tokens.bgElevated)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Tokens.borderSoft, lineWidth: 1)
        )
        .padding(.horizontal, 16)
    }
}

// TOGGLE — visual match for the design's switch.
struct SqToggle: View {
    @Binding var on: Bool
    var body: some View {
        Button { on.toggle() } label: {
            ZStack(alignment: on ? .trailing : .leading) {
                Capsule()
                    .fill(on ? Tokens.accent : Tokens.bgCard)
                    .overlay(Capsule().stroke(on ? Tokens.accent : Tokens.border, lineWidth: 1))
                    .frame(width: 44, height: 26)
                Circle().fill(Color.white).frame(width: 20, height: 20).padding(2)
            }
            .animation(.spring(response: 0.25, dampingFraction: 0.85), value: on)
        }
        .buttonStyle(.plain)
    }
}

// MONO text shortcut.
struct Mono: View {
    let text: String
    var size: CGFloat = 13
    var color: Color = Tokens.fg
    var weight: Font.Weight = .regular
    init(_ text: String, size: CGFloat = 13, color: Color = Tokens.fg, weight: Font.Weight = .regular) {
        self.text = text; self.size = size; self.color = color; self.weight = weight
    }
    var body: some View {
        Text(text).font(Fonts.mono(size, weight: weight)).foregroundStyle(color)
    }
}

// EMPTY STATE
struct EmptyMessage: View {
    let text: String
    var body: some View {
        VStack(spacing: 6) {
            Text(text)
                .font(.system(size: 13))
                .foregroundStyle(Tokens.fgDim)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40).padding(.horizontal, 20)
    }
}

// PAGE HEADER — large title + subtitle (matches .sq-h)
struct PageHeader: View {
    let title: String
    let subtitle: AnyView
    var trailing: AnyView? = nil
    init(title: String, subtitle: some View, trailing: (some View)? = nil as EmptyView?) {
        self.title = title
        self.subtitle = AnyView(subtitle)
        self.trailing = trailing.map { AnyView($0) }
    }
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 28, weight: .bold)).tracking(-0.6)
                    .foregroundStyle(Tokens.fg)
                subtitle.font(.system(size: 13)).foregroundStyle(Tokens.fgMuted)
            }
            Spacer()
            if let trailing { trailing }
        }
        .padding(.horizontal, 20).padding(.top, 14).padding(.bottom, 8)
    }
}
