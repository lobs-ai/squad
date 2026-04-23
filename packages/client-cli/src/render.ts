import type { Task, QuestionRecord, MessageRecord } from "@squad/protocol";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

export function renderDelta(delta: string): void {
  process.stdout.write(delta);
}

export function renderNewline(): void {
  process.stdout.write("\n");
}

export function renderAssistantMessage(msg: MessageRecord): void {
  // Final newline after streaming — text already came through as deltas.
  process.stdout.write("\n");
  void msg;
}

export function renderUserLine(prefix: string): void {
  process.stdout.write(`${BOLD}${CYAN}${prefix}${RESET} `);
}

export function renderToolCall(name: string, input: unknown): void {
  const preview = JSON.stringify(input).slice(0, 80);
  process.stdout.write(`\n${DIM}🔧 ${name}(${preview})${RESET}\n`);
}

export function renderTaskList(tasks: Task[]): void {
  const visible = tasks.filter((t) => t.status !== "deleted");
  if (visible.length === 0) return;
  process.stdout.write(`\n${BOLD}Tasks${RESET}\n`);
  for (const t of visible) {
    const glyph =
      t.status === "completed" ? `${GREEN}✓${RESET}` : t.status === "in_progress" ? `${YELLOW}◐${RESET}` : "○";
    const owner = t.owner ? ` ${DIM}(${t.owner})${RESET}` : "";
    process.stdout.write(`  ${glyph} ${t.subject}${owner}\n`);
  }
}

export function renderAskPrompt(q: QuestionRecord): string {
  let out = `\n${BOLD}${q.input.questions[0]!.question}${RESET}\n`;
  q.input.questions[0]!.options.forEach((opt, i) => {
    out += `  ${YELLOW}${i + 1}${RESET}. ${opt.label}  ${DIM}— ${opt.description}${RESET}\n`;
    if (opt.preview) {
      out += DIM + opt.preview.split("\n").map((l) => `     ${l}`).join("\n") + RESET + "\n";
    }
  });
  out += `  ${YELLOW}o${RESET}. Other… (free text)\n`;
  return out;
}

export function renderError(message: string): void {
  process.stdout.write(`\n${RED}error: ${message}${RESET}\n`);
}
