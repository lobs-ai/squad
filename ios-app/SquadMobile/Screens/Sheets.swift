import SwiftUI

// MARK: - Squad switcher

struct SquadSwitcherSheet: View {
    @EnvironmentObject var state: AppState
    var onClose: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color(hex: 0x333333)).frame(width: 40, height: 5).padding(.top, 8)
            HStack {
                Text("Switch squad").font(.system(size: 18, weight: .bold))
                    .foregroundStyle(Tokens.fg)
                Spacer()
                IconButton(icon: "xmark", action: onClose)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)

            ScrollView {
                CardView {
                    CardRow(isLast: true) {
                        Image(systemName: "globe")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(Tokens.accent)
                            .frame(width: 32, height: 32)
                            .background(Tokens.accentSoft)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("All squads").font(.system(size: 14, weight: .semibold))
                                .foregroundStyle(Tokens.fg)
                            Text("Aggregate overview, fan out feeds")
                                .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
                        }
                        Spacer()
                        SqToggle(on: Binding(
                            get: { state.allSquadsMode },
                            set: { state.allSquadsMode = $0 }
                        ))
                    }
                }

                SectionLabel(title: "Your squads")
                CardView {
                    ForEach(Array(state.paired.enumerated()), id: \.element.id) { i, sq in
                        Button { state.switchTo(sq); onClose() } label: {
                            CardRow(isLast: i == state.paired.count - 1) {
                                StatusDot(state: state.client.status == .connected
                                          && state.activeSquad?.id == sq.id ? .ok : .idle)
                                VStack(alignment: .leading, spacing: 2) {
                                    HStack(spacing: 6) {
                                        Mono(sq.name, size: 14, weight: .semibold)
                                        if state.activeSquad?.id == sq.id && !state.allSquadsMode {
                                            Text("· ACTIVE").font(.system(size: 10, weight: .bold))
                                                .foregroundStyle(Tokens.accent)
                                        }
                                    }
                                    Text(sq.url).font(Fonts.mono(11))
                                        .foregroundStyle(Tokens.fgDim).lineLimit(1).truncationMode(.middle)
                                }
                                Spacer()
                                if state.activeSquad?.id == sq.id && !state.allSquadsMode {
                                    Image(systemName: "checkmark").foregroundStyle(Tokens.accent)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                }

                NavigationLink {
                    AddSquadView(onAdded: { onClose() })
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                        Text("Add squad").font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(Tokens.fg)
                    .frame(maxWidth: .infinity).frame(height: 44)
                    .background(Tokens.bgElevated)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Tokens.border, lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, 26)
                }
            }
        }
        .scrollIndicators(.hidden)
    }
}

// Wrapper that runs the onboarding StepConnect flow inside a sheet.
struct AddSquadView: View {
    @EnvironmentObject var state: AppState
    var onAdded: () -> Void
    var body: some View {
        NavigationStack {
            ZStack {
                Tokens.bg.ignoresSafeArea()
                StepConnect(
                    step: 0, total: 1,
                    onPaired: { p in state.addPaired(p); onAdded() },
                    onBack: { onAdded() }
                )
            }
            .navigationBarBackButtonHidden(true)
        }
    }
}

// MARK: - Subagent tree
//
// (No SpawnSessionSheet — the dashboard creates a session with `session.start({})`
// and lands in the chat view immediately. The mobile FAB does the same. Choosing
// a model happens later in the chat header; spawning a named subagent happens
// from inside an existing session, not at create time.)


struct SubagentSheet: View {
    @EnvironmentObject var state: AppState
    let rootSessionId: String
    var onClose: () -> Void

    @State private var root: SubagentTreeNode?
    @State private var loading = true

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color(hex: 0x333333)).frame(width: 40, height: 5).padding(.top, 8)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Subagent tree").font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Tokens.fg)
                    Mono(String(rootSessionId.prefix(10)), size: 11, color: Tokens.fgDim)
                }
                Spacer()
                IconButton(icon: "xmark", action: onClose)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)

            if loading {
                ProgressView().padding(.top, 40)
            } else if let root {
                ScrollView {
                    VStack(spacing: 0) {
                        TreeRow(node: root, depth: 0)
                        treeChildren(of: root, depth: 1)
                    }
                    .padding(.top, 6)
                }
            } else {
                EmptyMessage(text: "No subagents under this session.")
            }
        }
        .scrollIndicators(.hidden)
        .task {
            do {
                self.root = try await state.client.subagentTree(rootSessionId: rootSessionId)
            } catch {
                self.root = nil
            }
            self.loading = false
        }
    }

    @ViewBuilder
    private func treeChildren(of node: SubagentTreeNode, depth: Int) -> some View {
        if let children = node.children {
            ForEach(children) { child in
                TreeBranch(node: child, depth: depth)
            }
        }
    }
}

// Recursive child branch — broken out so SwiftUI can infer a concrete type
// rather than a self-referential opaque return.
private struct TreeBranch: View {
    let node: SubagentTreeNode
    let depth: Int
    var body: some View {
        VStack(spacing: 0) {
            TreeRow(node: node, depth: depth)
            if let children = node.children {
                ForEach(children) { child in
                    TreeBranch(node: child, depth: depth + 1)
                }
            }
        }
    }
}

private struct TreeRow: View {
    let node: SubagentTreeNode
    let depth: Int
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Color.clear.frame(width: CGFloat(depth) * 24)
            StatusDot(state: dotState(node.status))
                .padding(.top, 6)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    Text(node.subagent ?? node.title ?? "session")
                        .font(Fonts.mono(13.5, weight: .semibold))
                        .foregroundStyle(Tokens.fg)
                    if node.status == "running" { Pulse() }
                    if let s = node.status {
                        Text(s.uppercased()).font(.system(size: 10))
                            .tracking(0.7).foregroundStyle(Tokens.fgDim)
                    }
                }
                if let title = node.title, title != (node.subagent ?? "") {
                    Text(title).font(.system(size: 12.5)).foregroundStyle(Tokens.fgMuted)
                }
                let tin = node.tokensIn ?? 0; let tout = node.tokensOut ?? 0
                Text("\(node.model ?? "—") · \(tin + tout) tok")
                    .font(Fonts.mono(10.5)).foregroundStyle(Tokens.fgDim)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Tokens.bgCard.opacity(depth.isMultiple(of: 2) ? 0 : 0.4))
        .overlay(Rectangle().fill(Tokens.borderSoft).frame(height: 0.5), alignment: .bottom)
    }
    private func dotState(_ s: String?) -> StatusDot.State {
        switch s {
        case "running": .ok
        case "queued":  .idle
        case "completed", "done": .ok
        case "failed":  .danger
        case "cancelled": .warn
        default:        .idle
        }
    }
}
