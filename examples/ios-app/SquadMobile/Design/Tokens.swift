import SwiftUI

// Design tokens lifted directly from packages/dashboard via squad-mobile/project/app/tokens.css.
// Names mirror the CSS variables so they stay traceable.
enum Tokens {
    // Backgrounds
    static let bg          = Color(hex: 0x0A0A0A)
    static let bgElevated  = Color(hex: 0x141414)
    static let bgCard      = Color(hex: 0x1A1A1A)
    static let bgHover     = Color(hex: 0x222222)

    // Foregrounds
    static let fg          = Color(hex: 0xE8E8E8)
    static let fgMuted     = Color(hex: 0x999999)
    static let fgDim       = Color(hex: 0x6B6B6B)

    // Borders
    static let border      = Color(hex: 0x2A2A2A)
    static let borderSoft  = Color(hex: 0x1F1F1F)

    // Accents / semantic
    static let accent      = Color(hex: 0x5B8DEF)
    static let accentSoft  = Color(red: 91/255,  green: 141/255, blue: 239/255, opacity: 0.14)
    static let accentLine  = Color(red: 91/255,  green: 141/255, blue: 239/255, opacity: 0.35)

    static let ok          = Color(hex: 0x22C55E)
    static let warn        = Color(hex: 0xF59E0B)
    static let danger      = Color(hex: 0xEF4444)
    static let info        = Color(hex: 0x3B82F6)
    static let magenta     = Color(hex: 0xC074F0)

    // Channel chip palette
    static let chDiscord   = Color(hex: 0x5865F2)
    static let chCli       = Color(hex: 0xC074F0)
    static let chDash      = Color(hex: 0x5B8DEF)
    static let chMobile    = Color(hex: 0x22C55E)

    // Radii (in points)
    static let radiusSm: CGFloat   = 8
    static let radius:   CGFloat   = 12
    static let radiusLg: CGFloat   = 16

    // Lock screen wallpaper gradient
    static let lockGradient = LinearGradient(
        colors: [Color(hex: 0x1E2742), Color(hex: 0x0A0D18), Color(hex: 0x050610)],
        startPoint: .bottom, endPoint: .top
    )
}

// SF Pro is the closest system equivalent for Inter; SF Mono for JetBrains Mono.
// We don't ship the proprietary fonts — system fonts give the same visual rhythm
// without the bundle size and licensing overhead.
enum Fonts {
    static func ui(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .default)
    }
    static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }
}

extension Color {
    init(hex: UInt32, opacity: Double = 1.0) {
        self.init(
            .sRGB,
            red:   Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >>  8) & 0xFF) / 255,
            blue:  Double( hex        & 0xFF) / 255,
            opacity: opacity
        )
    }
}
