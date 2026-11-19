/**
 * Codex SDK stream → normalized HarnessEvent stream.
 *
 * Codex emits an item-based stream (`item.started/updated/completed` carrying
 * typed items) rather than Anthropic-style content blocks. This maps it onto
 * the same `HarnessEvent` union the Claude adapter produces, so the gateway
 * ingests both identically (the lockstep boundary).
 *
 * Pure and stateful, typed structurally so it unit-tests without a live
 * `codex` process.
 */

import type { HarnessEvent, HarnessUsage } from "../types.js";

export interface CdxItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  aggregated_output?: string;
  exit_code?: number;
  status?: string;
  changes?: unknown;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: { content?: unknown; structured_content?: unknown };
  error?: { message?: string };
  query?: string;
}

export interface CdxEvent {
  type?: string;
  thread_id?: string;
  usage?: Record<string, unknown>;
  error?: { message?: string };
  message?: string;
  item?: CdxItem;
}

type ItemPhase = "started" | "updated" | "completed";

export class CodexNormalizer {
  private threadId: string | undefined;
  private initEmitted = false;
  private started = false;
  private emittedText = "";
  private emittedThinking = "";
  private readonly startedTools = new Set<string>();

  harnessSessionId(): string | undefined {
    return this.threadId;
  }

  next(ev: CdxEvent): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    switch (ev.type) {
      case "thread.started":
        if (ev.thread_id) this.threadId = ev.thread_id;
        this.ensureInit(out);
        return out;
      case "turn.started":
        this.ensureInit(out);
        this.ensureStarted(out);
        return out;
      case "item.started":
        this.ensureInit(out);
        this.ensureStarted(out);
        this.onItem(out, ev.item ?? {}, "started");
        return out;
      case "item.updated":
        this.ensureInit(out);
        this.onItem(out, ev.item ?? {}, "updated");
        return out;
      case "item.completed":
        this.ensureInit(out);
        this.onItem(out, ev.item ?? {}, "completed");
        return out;
      case "turn.completed":
        this.ensureInit(out);
        this.ensureStarted(out);
        out.push({ t: "turn.end", stopReason: "end_turn", usage: mapUsage(ev.usage) });
        return out;
      case "turn.failed":
        this.ensureInit(out);
        this.ensureStarted(out);
        out.push({
          t: "error",
          category: "turn",
          message: ev.error?.message ?? "codex turn failed",
          retryable: false,
        });
        out.push({ t: "turn.end", stopReason: "error", usage: mapUsage(undefined) });
        return out;
      case "error":
        out.push({
          t: "error",
          category: "stream",
          message: ev.message ?? "codex stream error",
          retryable: false,
        });
        return out;
      default:
        return out;
    }
  }

  private onItem(out: HarnessEvent[], item: CdxItem, phase: ItemPhase): void {
    switch (item.type) {
      case "agent_message":
        this.streamText(out, item.text ?? "", "text");
        return;
      case "reasoning":
        this.streamText(out, item.text ?? "", "thinking");
        return;
      case "command_execution":
      case "file_change":
      case "mcp_tool_call":
      case "web_search":
        this.toolItem(out, item, phase);
        return;
      default:
        // todo_list, unknown — no HarnessEvent equivalent.
        return;
    }
  }

  private toolItem(out: HarnessEvent[], item: CdxItem, phase: ItemPhase): void {
    const id = item.id ?? `${item.type}:${this.startedTools.size}`;
    const name = toolName(item);
    if (phase === "started" || phase === "completed") {
      if (!this.startedTools.has(id)) {
        this.startedTools.add(id);
        out.push({ t: "tool.start", id, name, input: toolInput(item) });
      }
    }
    if (phase === "completed") {
      out.push({
        t: "tool.end",
        id,
        output: toolOutput(item),
        isError: isToolError(item),
      });
    }
  }

  private streamText(out: HarnessEvent[], full: string, kind: "text" | "thinking"): void {
    const prev = kind === "text" ? this.emittedText : this.emittedThinking;
    const d = delta(prev, full);
    if (!d) return;
    if (kind === "text") {
      this.emittedText = d.next;
      out.push({ t: "text.delta", text: d.suffix });
    } else {
      this.emittedThinking = d.next;
      out.push({ t: "thinking.delta", text: d.suffix });
    }
  }

  private ensureInit(out: HarnessEvent[]): void {
    if (this.initEmitted) return;
    this.initEmitted = true;
    out.push({
      t: "session.init",
      harnessSessionId: this.threadId ?? "",
      model: "",
      tools: [],
    });
  }

  private ensureStarted(out: HarnessEvent[]): void {
    if (this.started) return;
    this.started = true;
    out.push({ t: "turn.start" });
  }
}

function delta(prev: string, full: string): { suffix: string; next: string } | null {
  if (!full || full === prev) return null;
  if (full.startsWith(prev)) return { suffix: full.slice(prev.length), next: full };
  return { suffix: full, next: full };
}

function toolName(item: CdxItem): string {
  switch (item.type) {
    case "command_execution":
      return "exec";
    case "file_change":
      return "apply_patch";
    case "web_search":
      return "web_search";
    case "mcp_tool_call":
      return item.tool ?? "tool";
    default:
      return item.type ?? "tool";
  }
}

function toolInput(item: CdxItem): unknown {
  switch (item.type) {
    case "command_execution":
      return { command: item.command ?? "" };
    case "file_change":
      return { changes: item.changes ?? [] };
    case "web_search":
      return { query: item.query ?? "" };
    case "mcp_tool_call":
      return item.arguments ?? {};
    default:
      return {};
  }
}

function toolOutput(item: CdxItem): unknown {
  switch (item.type) {
    case "command_execution":
      return item.aggregated_output ?? "";
    case "file_change":
      return item.status ?? "";
    case "mcp_tool_call":
      if (item.error?.message) return item.error.message;
      return extractMcpText(item.result?.content);
    case "web_search":
      return item.query ?? "";
    default:
      return "";
  }
}

function isToolError(item: CdxItem): boolean {
  if (item.type === "mcp_tool_call") return !!item.error;
  if (item.type === "command_execution") {
    return item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0);
  }
  if (item.type === "file_change") return item.status === "failed";
  return false;
}

function extractMcpText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type?: string; text?: string } => typeof b === "object" && b !== null)
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

function mapUsage(u: Record<string, unknown> | undefined): HarnessUsage {
  const usage: HarnessUsage = {
    inputTokens: num(u, "input_tokens"),
    outputTokens: num(u, "output_tokens"),
    cacheReadTokens: num(u, "cached_input_tokens"),
    thinkingTokens: num(u, "reasoning_output_tokens"),
  };
  return usage;
}

function num(o: Record<string, unknown> | undefined, key: string): number {
  if (!o) return 0;
  const v = o[key];
  return typeof v === "number" ? v : 0;
}
