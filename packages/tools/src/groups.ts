/**
 * Tool groups — a lazy-loading scheme that keeps the system prompt small.
 *
 * Default groups load on every turn. Non-default ("lazy") groups appear in
 * the prompt only as a one-line index entry; the agent calls
 * `describe_tool_group` to read the full guidance and unlock the group's
 * tool schemas for subsequent turns.
 *
 * The {@link ToolGroupRegistry} is the source of truth for which tool
 * names belong to which group; callers (the gateway) hold a per-session
 * set of unlocked group names and pass `groupsRegistry.activeToolNames(...)`
 * into the runner each turn.
 */

import { BaseTool, type ToolContext } from "./base-tool.js";
import type { ToolExecutorResult } from "./types.js";

export interface ToolGroup {
  /** Stable, lower-case identifier — the value passed to describe_tool_group. */
  name: string;
  /** One-line description shown in the system-prompt index. */
  description: string;
  /** Multi-paragraph guidance returned by describe_tool_group. */
  guidance: string;
  /** Tool names that compose this group. */
  toolNames: readonly string[];
  /** Default groups load on every turn; non-default groups stay hidden. */
  default?: boolean;
}

export class ToolGroupRegistry {
  private readonly groups = new Map<string, ToolGroup>();

  register(group: ToolGroup): this {
    this.groups.set(group.name, group);
    return this;
  }

  registerAll(groups: readonly ToolGroup[]): this {
    for (const g of groups) this.register(g);
    return this;
  }

  get(name: string): ToolGroup | undefined {
    return this.groups.get(name);
  }

  list(): ToolGroup[] {
    return [...this.groups.values()];
  }

  defaults(): ToolGroup[] {
    return this.list().filter((g) => g.default === true);
  }

  lazy(): ToolGroup[] {
    return this.list().filter((g) => g.default !== true);
  }

  /**
   * Tool names visible to the LLM this turn: every default group's tools
   * plus every tool from the unlocked-groups set.
   */
  activeToolNames(unlocked: Iterable<string>): string[] {
    const out = new Set<string>();
    for (const g of this.defaults()) for (const n of g.toolNames) out.add(n);
    for (const name of unlocked) {
      const g = this.groups.get(name);
      if (g) for (const n of g.toolNames) out.add(n);
    }
    return [...out];
  }
}

/**
 * Render the lazy groups as a compact `<tool_groups>` block for the
 * system prompt. Returns the empty string when there are no lazy groups.
 */
export function formatGroupIndexForPrompt(lazyGroups: readonly ToolGroup[]): string {
  if (lazyGroups.length === 0) return "";
  const lines: string[] = [
    "## Tool groups (lazy)",
    "",
    "Tools below are NOT loaded yet. Call `describe_tool_group` with one or",
    "more group names to read the guidance and unlock the schemas for the",
    "next turn. Pick a group only when its description matches the task.",
    "",
    "<tool_groups>",
  ];
  for (const g of lazyGroups) {
    lines.push(`  <group name="${g.name}">${escapeXml(g.description)}</group>`);
  }
  lines.push("</tool_groups>");
  return lines.join("\n");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── describe_tool_group ──────────────────────────────────────────────────────

interface DescribeInput extends Record<string, unknown> {
  groups: string[] | string;
}

/** Side-effect callback invoked once per resolved (and non-default) group. */
export type UnlockCallback = (
  sessionId: string | undefined,
  groupName: string,
) => void;

export class DescribeToolGroupTool extends BaseTool<DescribeInput> {
  readonly name = "describe_tool_group";
  readonly description = [
    "Load guidance and unlock tools for one or more lazy tool groups.",
    "The unlocked tools become callable on the next turn — this turn you",
    "only get the guidance text. Pass a single name or an array of names",
    "from the <tool_groups> index in the system prompt.",
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      groups: {
        oneOf: [
          { type: "string", description: "A single group name." },
          {
            type: "array",
            items: { type: "string" },
            description: "Multiple group names to unlock at once.",
          },
        ],
        description: "Group name (or array of names) from the <tool_groups> index.",
      },
    },
    required: ["groups"],
  };
  readonly tags = ["readonly", "meta"] as const;

  constructor(
    private readonly registry: ToolGroupRegistry,
    private readonly onUnlock: UnlockCallback,
  ) {
    super();
  }

  async run(input: DescribeInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const raw = Array.isArray(input.groups) ? input.groups : [input.groups];
    const sessionId = ctx.meta?.["sessionId"] as string | undefined;
    const sections: string[] = [];
    const unlocked: string[] = [];
    const skipped: string[] = [];

    for (const r of raw) {
      const name = String(r).toLowerCase();
      const g = this.registry.get(name);
      if (!g) {
        skipped.push(`${name} (unknown)`);
        continue;
      }
      if (g.default) {
        skipped.push(`${name} (already loaded)`);
        continue;
      }
      this.onUnlock(sessionId, name);
      unlocked.push(name);
      sections.push(
        [
          `# ${name}`,
          `Tools: ${g.toolNames.join(", ")}`,
          "",
          g.guidance.trim(),
        ].join("\n"),
      );
    }

    if (unlocked.length === 0) {
      const known = this.registry.lazy().map((g) => g.name).join(", ");
      throw new Error(
        `describe_tool_group: nothing to unlock. Skipped: ${skipped.join(", ") || "(none)"}. ` +
          `Known lazy groups: ${known || "(none)"}.`,
      );
    }

    sections.push(
      `_Unlocked: ${unlocked.join(", ")}. Tools become callable on the next turn._`,
    );
    if (skipped.length > 0) sections.push(`_Skipped: ${skipped.join(", ")}._`);

    return sections.join("\n\n---\n\n");
  }
}
