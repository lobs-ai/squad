import SwiftUI

struct ApprovalsView: View {
    @EnvironmentObject var state: AppState
    @State private var sending: Set<String> = []
    @State private var dragX: [String: CGFloat] = [:]

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 110)

                let pending = state.approvals.filter { $0.status == "pending" }
                let decided = state.approvals.filter { $0.status != "pending" }.prefix(8)

                PageHeader(
                    title: "Approvals",
                    subtitle: HStack(spacing: 4) {
                        Mono("\(pending.count) pending", size: 13, color: Tokens.fgMuted)
                        Text("· swipe right to approve, left to deny")
                            .foregroundStyle(Tokens.fgMuted)
                            .lineLimit(1)
                    }
                )

                if pending.isEmpty {
                    VStack(spacing: 10) {
                        Text("✓").font(.system(size: 42, weight: .light))
                            .foregroundStyle(Tokens.ok)
                        Text("All clear. \(state.branding.agentName.capitalized) has nothing waiting.")
                            .font(.system(size: 13)).foregroundStyle(Tokens.fgDim)
                    }
                    .padding(.top, 60)
                }

                ForEach(pending) { a in
                    SwipeCard(
                        approval: a,
                        dragX: dragX[a.id] ?? 0,
                        sending: sending.contains(a.id),
                        onDrag: { x in dragX[a.id] = x },
                        onRelease: { handleRelease(a) },
                        onApprove: { decide(a, "approve") },
                        onDeny: { decide(a, "deny") }
                    )
                }

                if !decided.isEmpty {
                    SectionLabel(title: "Recent decisions")
                    CardView {
                        ForEach(Array(decided.enumerated()), id: \.element.id) { i, a in
                            CardRow(isLast: i == decided.count - 1) {
                                Image(systemName: a.decision == "approve" ? "checkmark.circle.fill" : "xmark.circle.fill")
                                    .foregroundStyle(a.decision == "approve" ? Tokens.ok : Tokens.danger)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(a.toolName).font(Fonts.mono(13)).foregroundStyle(Tokens.fg)
                                    Text(timeAgo(a.decidedAt)).font(Fonts.mono(11)).foregroundStyle(Tokens.fgDim)
                                }
                                Spacer()
                            }
                        }
                    }
                }

                Color.clear.frame(height: 130)
            }
        }
        .scrollIndicators(.hidden)
        .refreshable { await state.refreshAll() }
    }

    private func handleRelease(_ a: ApprovalRecord) {
        let x = dragX[a.id] ?? 0
        if x > 110 { decide(a, "approve") }
        else if x < -110 { decide(a, "deny") }
        else { withAnimation(.spring(response: 0.3)) { dragX[a.id] = 0 } }
    }
    private func decide(_ a: ApprovalRecord, _ verdict: String) {
        sending.insert(a.id)
        Task {
            do {
                try await state.client.decideApproval(id: a.id, decision: verdict)
                await state.refreshApprovals()
            } catch {
                state.lastError = error.localizedDescription
            }
            sending.remove(a.id)
            dragX.removeValue(forKey: a.id)
        }
    }
}

private struct SwipeCard: View {
    @EnvironmentObject var state: AppState
    let approval: ApprovalRecord
    let dragX: CGFloat
    let sending: Bool
    var onDrag: (CGFloat) -> Void
    var onRelease: () -> Void
    var onApprove: () -> Void
    var onDeny: () -> Void

    var body: some View {
        let bg: AnyShapeStyle = if dragX > 50 {
            AnyShapeStyle(LinearGradient(colors: [Tokens.ok.opacity(0.18), Tokens.bgElevated],
                                         startPoint: .leading, endPoint: .trailing))
        } else if dragX < -50 {
            AnyShapeStyle(LinearGradient(colors: [Tokens.bgElevated, Tokens.danger.opacity(0.18)],
                                         startPoint: .leading, endPoint: .trailing))
        } else {
            AnyShapeStyle(Tokens.bgElevated)
        }

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Text(approval.primaryTag.uppercased())
                    .font(Fonts.mono(9, weight: .bold)).tracking(0.7)
                    .foregroundStyle(tagColor)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(tagColor.opacity(0.14))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                Mono(state.activeSquad?.name ?? "squad", size: 11, color: Tokens.fgDim)
                Spacer()
                Text(timeAgo(approval.createdAt))
                    .font(.system(size: 11)).foregroundStyle(Tokens.fgDim)
            }

            Text(approval.toolName)
                .font(Fonts.mono(12))
                .foregroundStyle(Tokens.fgMuted)

            Text(summary)
                .font(Fonts.mono(15, weight: .medium))
                .foregroundStyle(Tokens.fg)

            if let detail {
                Text(detail)
                    .font(Fonts.mono(12))
                    .foregroundStyle(Tokens.fgDim)
                    .lineLimit(3)
            }

            HStack(spacing: 8) {
                SqButton(title: "Deny", icon: "xmark", style: .ghost,
                         fullWidth: true, height: 42, action: onDeny)
                SqButton(title: "Approve", icon: "checkmark", style: .ok,
                         fullWidth: true, height: 42, action: onApprove)
            }

            HStack {
                HStack(spacing: 4) {
                    Image(systemName: "chevron.left.2"); Text("deny")
                }
                Spacer()
                HStack(spacing: 4) {
                    Text("approve"); Image(systemName: "chevron.right.2")
                }
            }
            .font(.system(size: 10)).foregroundStyle(Tokens.fgDim)
        }
        .padding(16)
        .background(bg)
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Tokens.border, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .padding(.horizontal, 16).padding(.bottom, 12)
        .offset(x: dragX)
        .rotationEffect(.degrees(Double(dragX) * 0.04))
        .opacity(sending ? 0.6 : 1)
        .gesture(
            DragGesture()
                .onChanged { v in onDrag(v.translation.width) }
                .onEnded { _ in onRelease() }
        )
        .animation(.interactiveSpring(), value: dragX)
    }

    private var tagColor: Color {
        switch approval.primaryTag.lowercased() {
        case "write": Tokens.warn; case "exec": Tokens.danger
        case "network", "net": Tokens.info; default: Tokens.fgMuted
        }
    }
    private var summary: String {
        if let obj = approval.input?.objectValue {
            if let path = obj["path"]?.stringValue { return path }
            if let cmd = obj["command"]?.stringValue { return cmd }
            if let url = obj["url"]?.stringValue { return url }
        }
        return approval.toolName
    }
    private var detail: String? {
        if let obj = approval.input?.objectValue {
            var parts: [String] = []
            for (k, v) in obj where !["path", "command", "url"].contains(k) {
                parts.append("\(k): \(v.prettyString)")
            }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        return nil
    }
}
