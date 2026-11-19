/**
 * ClaudeHarness — drives @anthropic-ai/claude-agent-sdk as a HarnessSession.
 *
 * Phase 1 is resume-per-turn: each `runTurn` runs one `query()` with
 * `resume = <prior harness session id>` and lets it complete. State between
 * turns is the harness session id (persisted by the gateway). True keep-warm
 * (a held streaming-input process) is a later optimization layered on the
 * WarmPool — the contract here stays resume-based, which is restart-safe and
 * identical to Codex's `resumeThread`.
 */

import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type {
  ApprovalHook,
  HarnessCaps,
  HarnessEvent,
  HarnessFactory,
  HarnessSession,
  HarnessStartSpec,
  HarnessTurnInput,
} from "../types.js";
import { ClaudeNormalizer, type RawSdkMessage } from "./normalize.js";
import { buildSquadSdkMcpServer } from "./mcp.js";
import { buildClaudeEnv } from "./env.js";

const CLAUDE_CAPS: HarnessCaps = {
  inProcessMcp: true,
  perCallApproval: true,
  thinking: true,
  resumeAcrossProcess: true,
};

class ClaudeHarness implements HarnessSession {
  readonly kind = "claude" as const;
  readonly caps = CLAUDE_CAPS;
  private hsid: string | undefined;
  private active: Query | undefined;

  constructor(
    readonly sessionId: string,
    private readonly spec: HarnessStartSpec,
    private readonly approval: ApprovalHook,
  ) {
    this.hsid = spec.resume;
  }

  async *runTurn(input: HarnessTurnInput): AsyncIterable<HarnessEvent> {
    const norm = new ClaudeNormalizer();
    const q = query({
      prompt: input.text,
      options: {
        model: this.spec.model,
        cwd: this.spec.cwd,
        env: buildClaudeEnv(this.spec),
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: this.spec.appendSystemPrompt,
        },
        mcpServers: { squad: buildSquadSdkMcpServer(this.spec.squadTools) },
        strictMcpConfig: true,
        // Availability: expose exactly the native built-ins the gateway chose
        // (MCP tools are unaffected by this list).
        tools: this.spec.allowedNativeTools,
        // Permission: pre-approve those built-ins + every squad MCP tool.
        allowedTools: [...this.spec.allowedNativeTools, "mcp__squad__*"],
        permissionMode: "default",
        canUseTool: this.canUseTool,
        includePartialMessages: true,
        ...(this.hsid ? { resume: this.hsid } : {}),
      },
    });
    this.active = q;
    try {
      for await (const msg of q) {
        for (const ev of norm.next(msg as unknown as RawSdkMessage)) yield ev;
      }
    } finally {
      this.active = undefined;
      const id = norm.harnessSessionId();
      if (id) this.hsid = id;
    }
  }

  harnessSessionId(): string | undefined {
    return this.hsid;
  }

  /** Bridge the SDK's per-call permission callback to Squad's approval engine. */
  private readonly canUseTool: CanUseTool = async (toolName, input, opts) => {
    const decision = await this.approval({
      toolName,
      input,
      toolUseId: opts.toolUseID,
      sessionId: this.sessionId,
      surface: this.spec.surface,
    });
    if (decision.behavior === "allow") {
      return decision.updatedInput
        ? { behavior: "allow", updatedInput: decision.updatedInput }
        : { behavior: "allow" };
    }
    return { behavior: "deny", message: decision.message };
  };

  async interrupt(): Promise<void> {
    try {
      await this.active?.interrupt();
    } catch {
      /* best-effort */
    }
  }

  async close(): Promise<void> {
    try {
      this.active?.close?.();
    } catch {
      /* best-effort */
    }
    this.active = undefined;
  }
}

export const claudeHarnessFactory: HarnessFactory = {
  kind: "claude",
  async open(spec, approval): Promise<HarnessSession> {
    return new ClaudeHarness(spec.sessionId, spec, approval);
  },
};
