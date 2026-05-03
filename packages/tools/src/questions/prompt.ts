import type {
  PromptContextSnapshot,
  RenderContext,
} from "../prompt-context.js";

export const ASK_SLOTS = {
  /**
   * Render-conditional. The bound channel teaches `ask_user` what its
   * native rendering is (button caps, label limits, preview support).
   */
  CHANNEL_CAPABILITIES: "ask_user.channel-capabilities",
  /**
   * Render-conditional. The bound channel asserts "questions delivered here
   * stay here" so the agent doesn't bounce them to the dashboard.
   */
  ESCALATION_TARGET: "ask_user.escalation-target",
  /**
   * Render-conditional. How `option.preview` renders in the bound channel
   * (code-block highlighting? plain text? not at all?). Lets the agent
   * pre-format previews for a channel that won't render markdown.
   */
  PREVIEW_RENDERING: "ask_user.preview-rendering",
} as const;

const STATIC = [
  "Use ask_user to clarify ambiguity, gather a preference, or offer a decision",
  "between concrete approaches. Do NOT use it for 'are you sure?' or 'should I proceed?'.",
  "",
  "- 2–4 options per question, mutually exclusive unless multiSelect is set.",
  "- Order with the recommended choice first and label it (Recommended).",
  "- Do NOT include a literal 'Other' option — the channel always surfaces one.",
  "- Use option.preview when the user benefits from seeing a concrete artifact",
  "  (ASCII mockup, code snippet, config diff). Skip it for pure preference questions.",
  "- Bundle related decisions into a single ask_user call (up to 4 sub-questions)",
  "  rather than asking them one at a time — the user answers them together.",
];

/**
 * Build the ask_user description against the live context. Channel-bound
 * fragments only appear when the current turn is rendering into that
 * channel — the dashboard never sees the Discord-button caveat, and vice
 * versa.
 */
export function buildAskGuidance(
  ctx: PromptContextSnapshot,
  render: RenderContext,
): string {
  const lines: string[] = [...STATIC];

  const caps = filterFragments(ctx, ASK_SLOTS.CHANNEL_CAPABILITIES, render);
  if (caps.length > 0) {
    lines.push("", "Channel rendering (this turn):");
    for (const f of caps) lines.push("  - " + f);
  }

  const esc = filterFragments(ctx, ASK_SLOTS.ESCALATION_TARGET, render);
  if (esc.length > 0) {
    lines.push("", "Where the question goes:");
    for (const f of esc) lines.push("  - " + f);
  }

  const preview = filterFragments(ctx, ASK_SLOTS.PREVIEW_RENDERING, render);
  if (preview.length > 0) {
    lines.push("", "option.preview rendering here:");
    for (const f of preview) lines.push("  - " + f);
  }

  return lines.join("\n");
}

function filterFragments(
  ctx: PromptContextSnapshot,
  slot: string,
  render: RenderContext,
): string[] {
  return ctx.fragments
    .filter((f) => f.slot === slot)
    .filter((f) => {
      if (!f.when) return true;
      try {
        return f.when(render, ctx);
      } catch {
        return false;
      }
    })
    .map((f) => f.content);
}

/** Backwards-compatible static fallback. */
export const ASK_GUIDANCE = STATIC.join("\n");
