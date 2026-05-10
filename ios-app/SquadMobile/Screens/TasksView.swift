import SwiftUI

struct TasksView: View {
    @EnvironmentObject var state: AppState
    @State private var seg: String = "in_progress"
    @State private var editing: TaskRecord?
    @State private var creating: Bool = false
    @State private var pendingDelete: TaskRecord?

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
                    trailing: HStack(spacing: 8) {
                        IconButton(icon: "plus") {
                            creating = state.defaultTaskSession != nil
                            if !creating { state.lastError = "Open a session before adding tasks" }
                        }
                        IconButton(icon: "line.3.horizontal.decrease")
                    }
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
                            TaskRow(
                                task: t,
                                isLast: i == visible.count - 1,
                                onCycleStatus: { Task { await state.updateTaskStatus(t, status: cycle(t.status)) } },
                                onEdit:        { editing = t },
                                onSetStatus:   { s in Task { await state.updateTaskStatus(t, status: s) } },
                                onDelete:      { pendingDelete = t }
                            )
                        }
                    }
                }

                Color.clear.frame(height: 130)
            }
        }
        .scrollIndicators(.hidden)
        .refreshable { await state.refreshAll() }
        .sheet(item: $editing) { t in
            TaskEditSheet(task: t, onClose: { editing = nil })
                .environmentObject(state)
                .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $creating) {
            TaskCreateSheet(onClose: { creating = false })
                .environmentObject(state)
                .presentationDetents([.medium])
        }
        .confirmationDialog(
            "Delete this task?",
            isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
            titleVisibility: .visible,
            presenting: pendingDelete
        ) { t in
            Button("Delete", role: .destructive) {
                Task { await state.deleteTask(t); pendingDelete = nil }
            }
            Button("Cancel", role: .cancel) { pendingDelete = nil }
        } message: { t in
            Text(t.subject)
        }
    }

    // pending → in_progress → completed → pending
    private func cycle(_ s: String) -> String {
        switch s {
        case "pending":     "in_progress"
        case "in_progress": "completed"
        case "completed":   "pending"
        default:            "in_progress"
        }
    }
}

private struct TaskRow: View {
    let task: TaskRecord
    let isLast: Bool
    let onCycleStatus: () -> Void
    let onEdit: () -> Void
    let onSetStatus: (String) -> Void
    let onDelete: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 12) {
                Button(action: onCycleStatus) {
                    checkmark
                        .frame(width: 24, height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.top, -1)

                Button(action: onEdit) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(task.subject)
                            .font(.system(size: 14))
                            .strikethrough(task.status == "completed")
                            .foregroundStyle(task.status == "completed" ? Tokens.fgDim : Tokens.fg)
                            .lineLimit(3)
                            .multilineTextAlignment(.leading)
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
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)
            .contextMenu {
                Button("Edit", systemImage: "pencil", action: onEdit)
                Section("Move to") {
                    if task.status != "pending"     { Button("To do",      systemImage: "circle")              { onSetStatus("pending") } }
                    if task.status != "in_progress" { Button("Doing",      systemImage: "play.circle")         { onSetStatus("in_progress") } }
                    if task.status != "completed"   { Button("Done",       systemImage: "checkmark.circle")    { onSetStatus("completed") } }
                }
                Button("Delete", systemImage: "trash", role: .destructive, action: onDelete)
            }

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
            .frame(width: 20, height: 20)
        case "in_progress":
            ZStack {
                Circle().strokeBorder(style: StrokeStyle(lineWidth: 1.5, dash: [3, 2]))
                    .foregroundStyle(Tokens.accent)
                Pulse().scaleEffect(0.7)
            }
            .frame(width: 20, height: 20)
        case "blocked":
            Circle().strokeBorder(Tokens.warn, lineWidth: 1.5)
                .frame(width: 20, height: 20)
        default:
            Circle().strokeBorder(Tokens.border, lineWidth: 1.5)
                .frame(width: 20, height: 20)
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

// MARK: - Edit sheet

private struct TaskEditSheet: View {
    @EnvironmentObject var state: AppState
    let task: TaskRecord
    var onClose: () -> Void

    @State private var subject: String
    @State private var desc: String
    @State private var owner: String
    @State private var status: String
    @State private var saving: Bool = false
    @State private var confirmingDelete: Bool = false

    init(task: TaskRecord, onClose: @escaping () -> Void) {
        self.task = task
        self.onClose = onClose
        _subject = State(initialValue: task.subject)
        _desc    = State(initialValue: task.description ?? "")
        _owner   = State(initialValue: task.owner ?? "")
        _status  = State(initialValue: task.status)
    }

    private let statuses: [(String, String)] = [
        ("pending", "To do"),
        ("in_progress", "Doing"),
        ("completed", "Done"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color(hex: 0x333333)).frame(width: 40, height: 5).padding(.top, 8)
            HStack {
                Text("Edit task").font(.system(size: 18, weight: .bold))
                    .foregroundStyle(Tokens.fg)
                Spacer()
                IconButton(icon: "xmark", action: onClose)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    fieldLabel("Subject")
                    inputBox { TextField("", text: $subject, axis: .vertical).lineLimit(1...3) }

                    fieldLabel("Description")
                    inputBox { TextField("", text: $desc, axis: .vertical).lineLimit(2...6) }

                    fieldLabel("Owner")
                    inputBox { TextField("\(state.branding.agentName) · \(state.branding.userName) · cron · …", text: $owner) }

                    fieldLabel("Status")
                    SegControl(
                        items: statuses.map { ($0.0, $0.1, nil as Int?) },
                        selection: $status
                    )
                    .padding(.horizontal, -16)

                    Mono("#\(task.id)", size: 11, color: Tokens.fgDim)
                        .padding(.top, 8)
                }
                .padding(.horizontal, 20).padding(.top, 8)
            }
            .scrollIndicators(.hidden)

            VStack(spacing: 8) {
                SqButton(title: saving ? "Saving…" : "Save", style: .primary) {
                    Task {
                        saving = true
                        await state.saveTaskEdits(task, subject: subject, description: desc, owner: owner, status: status)
                        saving = false
                        onClose()
                    }
                }
                SqButton(title: "Delete task", style: .danger) { confirmingDelete = true }
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
        }
        .background(Tokens.bg.ignoresSafeArea())
        .confirmationDialog("Delete this task?", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    await state.deleteTask(task)
                    onClose()
                }
            }
            Button("Cancel", role: .cancel) { }
        } message: { Text(task.subject) }
    }

    @ViewBuilder
    private func inputBox<C: View>(@ViewBuilder _ c: () -> C) -> some View {
        c()
            .textFieldStyle(.plain)
            .foregroundStyle(Tokens.fg)
            .font(.system(size: 14))
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Tokens.bgElevated)
            .overlay(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .stroke(Tokens.borderSoft, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
    private func fieldLabel(_ s: String) -> some View {
        Text(s.uppercased())
            .font(Fonts.ui(11, weight: .semibold))
            .tracking(0.88)
            .foregroundStyle(Tokens.fgMuted)
    }
}

// MARK: - Create sheet

private struct TaskCreateSheet: View {
    @EnvironmentObject var state: AppState
    var onClose: () -> Void

    @State private var subject: String = ""
    @State private var desc: String = ""
    @State private var saving: Bool = false

    var body: some View {
        VStack(spacing: 0) {
            Capsule().fill(Color(hex: 0x333333)).frame(width: 40, height: 5).padding(.top, 8)
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("New task").font(.system(size: 18, weight: .bold))
                        .foregroundStyle(Tokens.fg)
                    if let s = state.defaultTaskSession {
                        Mono("→ \(s.displayTitle)", size: 11, color: Tokens.fgDim)
                            .lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer()
                IconButton(icon: "xmark", action: onClose)
            }
            .padding(.horizontal, 18).padding(.vertical, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    fieldLabel("Subject")
                    TextField("What needs doing?", text: $subject, axis: .vertical)
                        .lineLimit(1...3)
                        .textFieldStyle(.plain)
                        .foregroundStyle(Tokens.fg)
                        .font(.system(size: 14))
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(Tokens.bgElevated)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(Tokens.borderSoft, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                    fieldLabel("Description (optional)")
                    TextField("", text: $desc, axis: .vertical)
                        .lineLimit(2...6)
                        .textFieldStyle(.plain)
                        .foregroundStyle(Tokens.fg)
                        .font(.system(size: 14))
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(Tokens.bgElevated)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .stroke(Tokens.borderSoft, lineWidth: 1)
                        )
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .padding(.horizontal, 20).padding(.top, 8)
            }
            .scrollIndicators(.hidden)

            SqButton(title: saving ? "Adding…" : "Add task", style: .primary) {
                let trimmed = subject.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty else { return }
                Task {
                    saving = true
                    await state.createTask(subject: trimmed, description: desc)
                    saving = false
                    onClose()
                }
            }
            .padding(.horizontal, 20).padding(.vertical, 14)
            .opacity(subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? 0.5 : 1)
            .disabled(subject.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .background(Tokens.bg.ignoresSafeArea())
    }

    private func fieldLabel(_ s: String) -> some View {
        Text(s.uppercased())
            .font(Fonts.ui(11, weight: .semibold))
            .tracking(0.88)
            .foregroundStyle(Tokens.fgMuted)
    }
}
