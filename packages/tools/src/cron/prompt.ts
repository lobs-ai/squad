import type {
  PromptContextSnapshot,
  PromptContextStore,
  RenderContext,
} from "../prompt-context.js";
import { PROMPT_SLOTS, type PromptSlot } from "../prompt-slots.js";

const STATIC_HEADER = [
  "Cron jobs let you schedule recurring or one-off work — agent prompts, scripts, or script-then-prompt chains.",
  "",
  "When to create a cron job:",
  '  - The user asks for "every / nightly / weekly / daily" automation.',
  '  - A one-shot future action ("remind me at 5pm", "open a cleanup PR in 2 weeks").',
  '  - A polling check ("check the deploy every 5 minutes until it lands").',
  "",
  "Schedule kinds:",
  '  - cron     → 5-field crontab, e.g. { kind: "cron", expr: "0 9 * * 1-5" } for 9am weekdays.',
  '  - interval → { kind: "interval", everyMs: 1800000 } for every 30 minutes.',
  '  - once     → { kind: "once", at: "2026-05-10T17:00:00Z" }; the job auto-disables after firing.',
  "",
  "Payload kinds (pick one):",
  '  - prompt           → run an agent turn. Pass { messages: [{ role: "user", text }] }.',
  "                       Add system messages for a custom system prompt; add skills[] to load skill instructions.",
  '  - script           → spawn a shell command (no LLM). Cheap; use for data collection,',
  "                       health checks, or anything that just needs to run code.",
  '  - scriptThenPrompt → run a script, then feed its stdout into an agent turn.',
  "                       Use {{output}} in any prompt message to splice the script's stdout in.",
  "                       If no message contains {{output}}, the stdout is appended as a final user message.",
  "                       Conditional: exit 0 → run the agent. Non-zero exit → status=error, no agent.",
  "                       Exit 0 with empty stdout → status=skipped, no agent (\"nothing to do\" path).",
  "",
  "Session targeting:",
  '  - new       → fresh session per fire (default; safe choice).',
  '  - isolated  → fresh session that does not show up in dashboards.',
  '  - session   → append to a specific existing session (use this for "agent picks up where it left off").',
  "",
  "Per-job model override: set execution.model (e.g. claude-haiku-4-5 for a cheap tick).",
  "Tool restriction: set execution.toolsAllow to constrain what tools the agent can call this run.",
  "Wake gate (script payload): print '[SILENT]' on the first line to skip delivery (run still logged).",
];

const STATIC_FOOTER = [
  "Scripts: spawned via `child_process.spawn(command, args, { cwd })`. cwd defaults to the gateway",
  "workspace dir; env is the gateway's process env. stdout+stderr are captured (capped 64KB), and",
  "the run is killed at min(execution.timeoutSec, 300s).",
  "",
  "After creating, you can call run_cron_job to fire it once immediately. Use list_cron_jobs",
  "to find an id, get_cron_runs to inspect history. Use list_delivery_kinds to find out",
  "which channels are wired up.",
];

/**
 * Build the cron tool's description against the live PromptContext + the
 * current turn's RenderContext. Adapts the delivery section to the actually
 * loaded handlers; appends fragments contributed by plugins for each cron
 * slot; defaults the delivery target / timezone to the current channel when
 * a fragment claims one.
 */
export function buildCronGuidance(
  ctx: PromptContextSnapshot,
  render: RenderContext,
): string {
  const lines: string[] = [...STATIC_HEADER, ""];

  // ── Delivery section ─────────────────────────────────────────────────────
  lines.push("Delivery (where the output goes):");
  lines.push("  - silent     → run logged, nothing sent anywhere.");
  lines.push("  - dashboard  → open the resulting session in the chat UI (default).");

  const handlerFragments = filterFragments(ctx, PROMPT_SLOTS.CRON_DELIVERY_HANDLERS, render);
  if (handlerFragments.length > 0) {
    for (const f of handlerFragments) {
      lines.push("  - " + f.replace(/\n/g, "\n    "));
    }
  } else {
    lines.push(
      "  - No channel plugins are loaded. To deliver anywhere besides the dashboard,",
      "    install a channel plugin (e.g. channel-discord) via plugin_install.",
    );
  }

  const deliveryDefault = filterFragments(ctx, PROMPT_SLOTS.CRON_DELIVERY_DEFAULT, render);
  if (deliveryDefault.length > 0) {
    lines.push("");
    for (const f of deliveryDefault) lines.push("  Default: " + f);
  }

  lines.push(
    "",
    "  Multiple destinations: each cron job has one delivery target. To fan out to",
    "  two Discord channels (or Discord + Slack), create two jobs with the same",
    "  schedule + payload but different delivery configs.",
  );

  // ── Timezone hint (render-conditional) ───────────────────────────────────
  const tz = filterFragments(ctx, PROMPT_SLOTS.CRON_TIMEZONE_DEFAULT, render);
  if (tz.length > 0) {
    lines.push("", "Timezone:");
    for (const f of tz) lines.push("  " + f);
  }

  // ── Costly skills (static) ────────────────────────────────────────────────
  const skills = filterFragments(ctx, PROMPT_SLOTS.CRON_SKILL_AVAILABILITY, render);
  if (skills.length > 0) {
    lines.push("", "Skill scheduling notes:");
    for (const f of skills) lines.push("  - " + f);
  }

  // ── Silent gate applicability ────────────────────────────────────────────
  const silent = filterFragments(ctx, PROMPT_SLOTS.DELIVERY_SILENT_GATE, render);
  if (silent.length > 0) {
    lines.push("", "[SILENT] gate behavior:");
    for (const f of silent) lines.push("  - " + f);
  }

  lines.push("");
  lines.push(...STATIC_FOOTER);

  return lines.join("\n");
}

/**
 * Build the schema description for the `delivery.kind` field. Static enums
 * stay; dynamic delivery handlers are listed inline so the agent picks a
 * kind that's actually registered.
 */
export function buildDeliverySchemaDescription(ctx: PromptContextSnapshot): string {
  const live = ctx.deliveryKinds.filter((k) => !k.builtIn).map((k) => k.kind);
  const liveNote =
    live.length > 0
      ? `Plugin-registered: ${live.join(", ")}.`
      : "No plugin handlers loaded — only silent/dashboard work.";
  return [
    "Where to send the run output.",
    "Built-in: 'silent' (no delivery), 'dashboard' (open in chat UI).",
    liveNote,
    "Pass plugin-handler-specific fields under `extras` (or use top-level channelId for discord).",
  ].join(" ");
}

function filterFragments(
  ctx: PromptContextSnapshot,
  slot: PromptSlot,
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

/**
 * Convenience: render directly from a store rather than a frozen snapshot.
 */
export function buildCronGuidanceFromStore(
  store: PromptContextStore,
  render: RenderContext,
): string {
  return buildCronGuidance(store.get(), render);
}

/**
 * Backwards-compatible static fallback. Tools that haven't been wired into
 * a {@link PromptContextStore} yet (e.g. legacy tests) still get something
 * meaningful. Same content as a fresh empty PromptContext would render.
 */
export const CRON_GUIDANCE = buildCronGuidance(
  {
    channels: [],
    deliveryKinds: [],
    plugins: [],
    skills: [],
    toolsets: [],
    fragments: [],
    startupWarnings: [],
    version: 0,
  },
  { surface: "unknown" },
);
