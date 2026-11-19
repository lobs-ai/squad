/**
 * Claude SDK stream → normalized HarnessEvent stream.
 *
 * Pure and stateful: feed it each `SDKMessage` from `query()` and it returns
 * the HarnessEvents to forward. Typed against a structural message shape (not
 * the SDK's exported types) so it unit-tests without a live `claude` process
 * and survives minor SDK type drift.
 *
 * Text handling avoids double-emission: streaming `partial_assistant` deltas
 * and the complete `assistant` message reconcile against the same accumulator,
 * and if neither produced text (partials disabled / empty), the terminal
 * `result` text is emitted once as a fallback.
 */

import type { HarnessEvent, HarnessStopReason, HarnessUsage } from "../types.js";

const SQUAD_PREFIX = "mcp__squad__";

export interface RawBlock {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  content?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
}

export interface RawSdkMessage {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  tools?: unknown;
  message?: { content?: RawBlock[]; model?: string; stop_reason?: string };
  partial?: { content?: RawBlock[] };
  result?: string;
  usage?: Record<string, unknown>;
  total_cost_usd?: number;
  num_turns?: number;
  stop_reason?: string;
  is_error?: boolean;
}

export class ClaudeNormalizer {
  private hsid: string | undefined;
  private model = "";
  private started = false;
  private anyText = false;
  private emittedText = "";
  private emittedThinking = "";

  harnessSessionId(): string | undefined {
    return this.hsid;
  }

  next(msg: RawSdkMessage): HarnessEvent[] {
    switch (msg.type) {
      case "system":
        return msg.subtype === "init" ? this.onInit(msg) : [];
      case "partial_assistant":
        return this.streamBlocks(msg.partial?.content ?? []);
      case "assistant":
        return this.onAssistant(msg);
      case "user":
        return this.onUser(msg);
      case "result":
        return this.onResult(msg);
      default:
        return [];
    }
  }

  private onInit(msg: RawSdkMessage): HarnessEvent[] {
    if (msg.session_id) this.hsid = msg.session_id;
    this.model = msg.model ?? "";
    const out: HarnessEvent[] = [
      {
        t: "session.init",
        harnessSessionId: this.hsid ?? "",
        model: this.model,
        tools: toolNames(msg.tools),
      },
    ];
    this.ensureStarted(out);
    return out;
  }

  private onAssistant(msg: RawSdkMessage): HarnessEvent[] {
    const blocks = msg.message?.content ?? [];
    const out: HarnessEvent[] = [];
    this.ensureStarted(out);
    out.push(...this.streamBlocks(blocks));
    for (const b of blocks) {
      if (b.type === "tool_use" && b.id) {
        out.push({
          t: "tool.start",
          id: b.id,
          name: stripSquadPrefix(b.name ?? "tool"),
          input: b.input ?? {},
        });
      }
    }
    return out;
  }

  private onUser(msg: RawSdkMessage): HarnessEvent[] {
    const blocks = msg.message?.content ?? [];
    const out: HarnessEvent[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result" && b.tool_use_id) {
        out.push({
          t: "tool.end",
          id: b.tool_use_id,
          output: extractResultText(b.content),
          isError: b.is_error === true,
        });
      }
    }
    return out;
  }

  private onResult(msg: RawSdkMessage): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    this.ensureStarted(out);
    // Fallback: if no assistant text streamed (partials off / tool-only turn
    // with a final summary), surface the canonical result text once.
    if (!this.anyText && typeof msg.result === "string" && msg.result.length > 0) {
      out.push({ t: "text.delta", text: msg.result });
      this.anyText = true;
    }
    out.push({ t: "turn.end", stopReason: mapStop(msg), usage: mapUsage(msg) });
    return out;
  }

  /** Reconcile cumulative text/thinking from a set of content blocks. */
  private streamBlocks(blocks: RawBlock[]): HarnessEvent[] {
    const out: HarnessEvent[] = [];
    const text = textOf(blocks);
    const thinking = thinkingOf(blocks);

    const td = delta(this.emittedText, text);
    if (td) {
      this.emittedText = td.next;
      this.anyText = true;
      out.push({ t: "text.delta", text: td.suffix });
    }
    const kd = delta(this.emittedThinking, thinking);
    if (kd) {
      this.emittedThinking = kd.next;
      out.push({ t: "thinking.delta", text: kd.suffix });
    }
    return out;
  }

  private ensureStarted(out: HarnessEvent[]): void {
    if (!this.started) {
      out.push({ t: "turn.start" });
      this.started = true;
    }
  }
}

/**
 * Incremental text diff. A new content segment (post-tool-call) restarts its
 * cumulative text, so a non-prefix is treated as a fresh suffix rather than a
 * rewrite — net emission stays the concatenation of all segments.
 */
function delta(prev: string, full: string): { suffix: string; next: string } | null {
  if (!full || full === prev) return null;
  if (full.startsWith(prev)) return { suffix: full.slice(prev.length), next: full };
  return { suffix: full, next: full };
}

function textOf(blocks: RawBlock[]): string {
  return blocks
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");
}

function thinkingOf(blocks: RawBlock[]): string {
  return blocks
    .filter((b) => b.type === "thinking" && typeof b.thinking === "string")
    .map((b) => b.thinking!)
    .join("");
}

function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type?: string; text?: string } =>
          typeof b === "object" && b !== null,
      )
      .map((b) => (typeof b.text === "string" ? b.text : ""))
      .join("");
  }
  return "";
}

function stripSquadPrefix(name: string): string {
  return name.startsWith(SQUAD_PREFIX) ? name.slice(SQUAD_PREFIX.length) : name;
}

function toolNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .map((t) => (typeof t === "string" ? t : isRecord(t) && typeof t.name === "string" ? t.name : null))
    .filter((n): n is string => n !== null);
}

function mapStop(msg: RawSdkMessage): HarnessStopReason {
  switch (msg.subtype) {
    case "success":
      return "end_turn";
    case "error_max_turns":
      return "max_turns";
    case "error_max_budget_usd":
    case "error_during_execution":
    case "error_max_structured_output_retries":
      return "error";
    default:
      return msg.is_error ? "error" : "end_turn";
  }
}

function mapUsage(msg: RawSdkMessage): HarnessUsage {
  const u = msg.usage ?? {};
  const usage: HarnessUsage = {
    inputTokens: num(u, "input_tokens"),
    outputTokens: num(u, "output_tokens"),
    cacheReadTokens: num(u, "cache_read_input_tokens"),
    cacheWriteTokens: num(u, "cache_creation_input_tokens"),
  };
  if (typeof msg.total_cost_usd === "number") usage.costUsd = msg.total_cost_usd;
  return usage;
}

function num(o: Record<string, unknown>, key: string): number {
  const v = o[key];
  return typeof v === "number" ? v : 0;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
