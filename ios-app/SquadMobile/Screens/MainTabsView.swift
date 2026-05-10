import SwiftUI

// Top-level tabbed shell. The CSS prototype hand-rolls its own tab bar; we mirror
// that visual instead of using SwiftUI's stock TabView so we can match the
// active-tab top accent and the dock styling exactly.

enum Tab: Hashable, CaseIterable {
    case home, sessions, tasks, approvals, more
    var label: String {
        switch self {
        case .home: "home"; case .sessions: "sessions"; case .tasks: "tasks"
        case .approvals: "approve"; case .more: "more"
        }
    }
    var symbol: String {
        switch self {
        case .home: "house"; case .sessions: "message"; case .tasks: "checklist"
        case .approvals: "checkmark.shield"; case .more: "ellipsis"
        }
    }
}

enum OverlayScreen: Hashable, Identifiable {
    case chat(String)
    case search
    case squads
    case notifications
    var id: String {
        switch self {
        case .chat(let id): "chat-\(id)"
        case .search: "search"; case .squads: "squads"; case .notifications: "notifications"
        }
    }
}

enum SheetKind: Hashable, Identifiable {
    case squadSwitcher
    case subagentTree(String)
    var id: String {
        switch self {
        case .squadSwitcher: "squad"
        case .subagentTree(let id): "subagents-\(id)"
        }
    }
}

struct MainTabsView: View {
    @EnvironmentObject var state: AppState
    @State private var tab: Tab = .home
    @State private var overlay: [OverlayScreen] = []
    @State private var sheet: SheetKind?
    @State private var toast: String?
    @State private var creatingSession = false

    func go(_ where_: NavigationIntent) {
        switch where_ {
        case .back:                    if !overlay.isEmpty { overlay.removeLast() }
        case .chat(let id):            overlay.append(.chat(id))
        case .search:                  overlay.append(.search)
        case .squads:                  overlay.append(.squads)
        case .notifications:           overlay.append(.notifications)
        case .approvals:               tab = .approvals
        case .openSheet(let kind):     sheet = kind
        case .toast(let text):
            toast = text
            Task { try? await Task.sleep(nanoseconds: 1_700_000_000); toast = nil }
        }
    }

    var body: some View {
        ZStack {
            Tokens.bg.ignoresSafeArea()

            // Base tabs (hidden when an overlay is presented)
            ZStack {
                switch tab {
                case .home:      HomeView(go: go)
                case .sessions:  SessionsView(go: go)
                case .tasks:     TasksView()
                case .approvals: ApprovalsView()
                case .more:      MoreView(go: go)
                }
            }
            .opacity(overlay.isEmpty ? 1 : 0)

            // Overlay screens (fullscreen "push")
            if let top = overlay.last {
                Group {
                    switch top {
                    case .chat(let sessionId):
                        ChatView(sessionId: sessionId, go: go)
                    case .search:
                        SearchView(go: go)
                    case .squads:
                        SquadsView(go: go)
                    case .notifications:
                        NotificationsView(go: go)
                    }
                }
                .transition(.opacity)
            }

            // Sticky topbar (suppressed for overlays — they bring their own)
            if overlay.isEmpty {
                VStack(spacing: 0) {
                    TopBar(onPickSquad: { sheet = .squadSwitcher },
                           onSearch: { go(.search) },
                           onNotifications: { go(.notifications) })
                    Spacer()
                }
            }

            // FAB on home/sessions — instant new chat (matches dashboard).
            if overlay.isEmpty && (tab == .home || tab == .sessions) {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Button { startNewChat() } label: {
                            Image(systemName: creatingSession ? "ellipsis" : "plus")
                                .font(.system(size: 22, weight: .bold))
                                .foregroundStyle(.white)
                                .frame(width: 56, height: 56)
                                .background(Tokens.accent.opacity(creatingSession ? 0.6 : 1))
                                .clipShape(Circle())
                                .shadow(color: Tokens.accent.opacity(0.45), radius: 14, y: 12)
                        }
                        .buttonStyle(.plain)
                        .padding(.trailing, 18)
                        .padding(.bottom, 110)
                    }
                }
            }

            // Tab dock
            if overlay.isEmpty {
                VStack {
                    Spacer()
                    TabBar(tab: $tab, badges: tabBadges)
                }
            }

            if let toast {
                ToastView(text: toast)
                    .padding(.bottom, 130)
                    .frame(maxHeight: .infinity, alignment: .bottom)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .sheet(item: $sheet) { kind in
            switch kind {
            case .squadSwitcher:
                SquadSwitcherSheet(onClose: { sheet = nil })
                    .presentationDetents([.medium, .large])
                    .presentationBackground(Color(hex: 0x161616))
            case .subagentTree(let id):
                SubagentSheet(rootSessionId: id, onClose: { sheet = nil })
                    .presentationDetents([.medium, .large])
                    .presentationBackground(Color(hex: 0x161616))
            }
        }
        .animation(.easeInOut(duration: 0.18), value: overlay.count)
    }

    private func startNewChat() {
        guard !creatingSession else { return }
        creatingSession = true
        Task {
            if let id = await state.startBlankSession() {
                go(.chat(id))
            }
            creatingSession = false
        }
    }

    private var tabBadges: [Tab: TabBadge] {
        var b: [Tab: TabBadge] = [:]
        if !state.questions.isEmpty { b[.sessions] = .accent }
        let approvals = state.approvals.filter { $0.status == "pending" }
        if !approvals.isEmpty { b[.approvals] = .danger }
        return b
    }
}

// Navigation intents thread through screens.
enum NavigationIntent {
    case back
    case chat(String)
    case search
    case squads
    case notifications
    case approvals
    case openSheet(SheetKind)
    case toast(String)
}

// MARK: - TopBar (sticky pill + search/bell)

struct TopBar: View {
    @EnvironmentObject var state: AppState
    var onPickSquad: () -> Void
    var onSearch: () -> Void
    var onNotifications: () -> Void

    var body: some View {
        let active = state.activeSquad
        let healthy = state.client.status == .connected
        let pending = state.questions.filter { $0.status == "pending" }.count
                    + state.approvals.filter { $0.status == "pending" }.count

        HStack(spacing: 10) {
            PillButton(
                title: state.allSquadsMode ? "all squads" : (active?.name ?? "squad"),
                dotColor: healthy ? Tokens.ok : Tokens.fgDim,
                trailing: { Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Tokens.fgMuted)
                },
                action: onPickSquad
            )
            Spacer()
            IconButton(icon: "magnifyingglass", action: onSearch)
            IconButton(
                icon: "bell",
                badge: pending > 0 ? "\(pending)" : nil,
                action: onNotifications
            )
        }
        .padding(.horizontal, 14)
        .frame(height: 56)
        .background(
            LinearGradient(colors: [
                Tokens.bg.opacity(0.92),
                Tokens.bg.opacity(0.65),
                Tokens.bg.opacity(0)
            ], startPoint: .top, endPoint: .bottom)
        )
        .padding(.top, 0)
    }
}

// MARK: - Tab dock

enum TabBadge { case danger, accent }

struct TabBar: View {
    @Binding var tab: Tab
    var badges: [Tab: TabBadge] = [:]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Tab.allCases, id: \.self) { t in
                Button { tab = t } label: {
                    VStack(spacing: 3) {
                        ZStack(alignment: .topTrailing) {
                            Image(systemName: t.symbol)
                                .font(.system(size: 19, weight: tab == t ? .semibold : .regular))
                                .foregroundStyle(tab == t ? Tokens.accent : Tokens.fgDim)
                            if let badge = badges[t] {
                                Circle()
                                    .fill(badge == .danger ? Tokens.danger : Tokens.accent)
                                    .frame(width: 7, height: 7)
                                    .overlay(Circle().stroke(Color(hex: 0x0E0E10), lineWidth: 1.5))
                                    .offset(x: 5, y: -3)
                            }
                        }
                        Text(t.label)
                            .font(Fonts.mono(9.5, weight: .semibold))
                            .tracking(0.4)
                            .foregroundStyle(tab == t ? Tokens.accent : Tokens.fgDim)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8).padding(.bottom, 4)
                    .overlay(alignment: .top) {
                        if tab == t {
                            RoundedRectangle(cornerRadius: 1)
                                .fill(Tokens.accent)
                                .frame(width: 24, height: 2)
                                .shadow(color: Tokens.accent.opacity(0.6), radius: 4)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(
            Color(hex: 0x0E0E10).opacity(0.86)
                .background(.ultraThinMaterial)
                .overlay(Rectangle().fill(Color.white.opacity(0.07)).frame(height: 0.5), alignment: .top)
                .ignoresSafeArea(edges: .bottom)
        )
    }
}

// MARK: - Toast

struct ToastView: View {
    let text: String
    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "checkmark").font(.system(size: 12, weight: .bold))
            Text(text).font(.system(size: 13, weight: .medium))
        }
        .foregroundStyle(Tokens.ok)
        .padding(.horizontal, 14).padding(.vertical, 8)
        .background(Tokens.ok.opacity(0.18).background(.ultraThinMaterial))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Tokens.ok.opacity(0.4), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
