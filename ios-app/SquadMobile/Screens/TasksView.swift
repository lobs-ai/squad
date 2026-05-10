import SwiftUI

struct TasksView: View {
    @EnvironmentObject var state: AppState
    @State private var seg: String = "in_progress"

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                Color.clear.frame(height: 110)

                PageHeader(
                    title: "Tasks",
                    subtitle: HStack(spacing: 4) {
                        Text("Across all sessions ·").foregroundStyle(Tokens.fgMuted)
                        Mono("\(state.tasks.count) total", size: 13, color: Tokens.fgMuted)
                    },
                    trailing: IconButton(icon: "line.3.horizontal.decrease")
                )

                let counts: [String: Int] = Dictionary(grouping: state.tasks, by: \.status).mapValues(\.count)
                SegControl(items: [
                    ("pending",     "To do",   counts["pending"] ?? 0),
                    ("in_progress", "Doing",   counts["in_progress"] ?? 0),
                    ("blocked",     "Blocked", counts["blocked"] ?? 0),
                    ("completed",   "Done",    counts["completed"] ?? 0),
                ], selection: $seg)

                CardView {
                    let visible = state.tasks.filter { $0.status == seg }
                    if visible.isEmpty {
                        EmptyMessage(text: "No tasks here.")
                    } else {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { i, t in
                            TaskRow(task: t, isLast: i == visible.count - 1)
                        }
                    }
                }

                Color.clear.frame(height: 130)
            }
        }
        .scrollIndicators(.hidden)
        .refreshable { await state.refreshAll() }
    }
}

private struct TaskRow: View {
    let task: TaskRecord
    let isLast: Bool
    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                checkmark
                    .frame(width: 20, height: 20)
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 4) {
                    Text(task.subject)
                        .font(.system(size: 14))
                        .strikethrough(task.status == "completed")
                        .foregroundStyle(task.status == "completed" ? Tokens.fgDim : Tokens.fg)
                        .lineLimit(3)
                    HStack(spacing: 6) {
                        Text("#\(String(task.id.prefix(6)))").foregroundStyle(Tokens.fgDim)
                        if let owner = task.owner, !owner.isEmpty {
                            Text("·").foregroundStyle(Tokens.fgDim)
                            HStack(spacing: 3) {
                                Image(systemName: ownerIcon(owner))
                                    .font(.system(size: 10))
                                Text(owner)
                            }
                            .foregroundStyle(Tokens.fgDim)
                        }
                        if let deps = task.blockedBy, !deps.isEmpty {
                            Text("· deps \(deps.count)")
                                .foregroundStyle(Tokens.warn)
                        }
                    }
                    .font(Fonts.mono(11))
                }
                Spacer()
            }
            .padding(.horizontal, 16).padding(.vertical, 12)

            if !isLast { Divider().background(Tokens.borderSoft) }
        }
    }
    @ViewBuilder
    private var checkmark: some View {
        switch task.status {
        case "completed":
            ZStack {
                Circle().fill(Tokens.ok)
                Image(systemName: "checkmark").font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color(hex: 0x0A0A0A))
            }
        case "in_progress":
            ZStack {
                Circle().strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [3, 2]))
                    .foregroundStyle(Tokens.accent)
                Pulse().scaleEffect(0.7)
            }
        case "blocked":
            Circle().strokeBorder(Tokens.warn, lineWidth: 1.5)
        default:
            Circle().strokeBorder(Tokens.border, lineWidth: 1.5)
        }
    }
    private func ownerIcon(_ owner: String) -> String {
        switch owner {
        case "user": "person"
        case "cron": "clock"
        default: "point.3.connected.trianglepath.dotted"
        }
    }
}
