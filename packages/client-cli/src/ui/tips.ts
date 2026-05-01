/**
 * Random tips shown at REPL startup. Adapted from hermes_cli/tips.py but
 * filtered down to features squad actually has (gateway, sessions, tasks,
 * ask-user, subagents) plus CLI affordances this package exposes.
 *
 * Tip strings are templates — `{agent}` is interpolated at read time from
 * the active skin's `agent_name` (after `loadGatewayBranding` overrides it
 * from `admin.identity`), so a rebrand to "Jarvis" reflows every tip
 * without touching this file. We don't interpolate "you" here on purpose:
 * every "you" in this list is second-person prose ("where you left off"),
 * not a speaker label. "subagent" stays a fixed literal — subagents are
 * spawned ad-hoc per task, so they don't share a single brandable name.
 */

import { brandString } from "./skin.js";

const TIPS: string[] = [
  // --- Slash commands ---
  "/help lists every slash command. Prefix matching works — /h → /help, /t → /tasks.",
  "/tasks shows the current session's task list — {agent} marks tasks complete as it goes.",
  "/questions lists open ask-user prompts {agent} is waiting on.",
  "/resume picks up where you left off in a previously named session.",
  "/sessions switches to a session picker — browse, resume, or start fresh.",
  "/new starts a brand-new session without losing the old one — switch back with /resume.",
  "/title \"my project\" names your session so it's easy to find with /sessions later.",
  "/status shows gateway liveness, current session id, and open question count.",
  "/clear wipes the terminal. History and session are preserved.",
  "/verbose toggles tool-call detail: compact → full-args → full-output.",
  "/skin mono switches the CLI theme. Try: default, mono, slate, poseidon, ares.",
  "/statusbar toggles the bottom bar showing gateway/session/tasks at a glance.",
  "/quit or Ctrl+D exits. Ctrl+C once cancels the current prompt; twice exits.",

  // --- Ask-user answers ---
  "When {agent} asks a multi-choice question, type 1/2/3 to pick — or type freeform for \"Other\".",
  "Pending questions persist across sessions. /questions shows what's still open.",

  // --- CLI flags & subcommands ---
  "squad chat \"one-shot\" sends a single message and exits — handy for scripts.",
  "squad chat --new forces a fresh session instead of resuming the last one.",
  "squad repl --resume reopens your last session. No flag = start fresh.",
  "squad sessions new \"title\" creates a named session you can /resume later.",
  "squad status tells you if the gateway is up and prints the current session.",
  "squad logs -f tails gateway.log — follow what {agent} is doing under the hood.",
  "squad key wizard generates an SSH key under docker/data/ssh so {agent} can git push.",
  "squad onboard re-runs the setup wizard — rewrites docker/config.json + docker/.env.",
  "squad start --docker or --local to pick the runtime. Omit to auto-detect.",

  // --- Environment ---
  "SQUAD_URL and SQUAD_TOKEN override docker/.env. Useful for connecting to remote gateways.",
  "SQUAD_PORT overrides just the port when the gateway isn't on 8080.",
  "NO_COLOR=1 disables ANSI colors. TERM=dumb also works.",
  "SQUAD_SKIN=slate loads a skin without persisting the choice.",

  // --- Architecture reminders ---
  "Every client — Discord, dashboard, CLI, your own UI — speaks the same WebSocket wire.",
  "Subagents run in parallel with their own model, tools, and budget. Each has its own session.",
  "Tasks are shared across parent and subagents — one list, updated live, every client sees it.",
  "Ask-user is channel-native: Discord buttons, dashboard cards, CLI selects — one tool call.",
  "Every run is a searchable session. FTS5 search lives in the dashboard and gateway API.",

  // --- Power-user ---
  "Paste multi-line messages directly — the REPL keeps them intact, no escaping needed.",
  "Type a new message while {agent} is working to interrupt it — or wait for the turn to finish.",
  "Ctrl+C during a running turn sends a cancel. Press twice in 2s to exit the REPL.",
  "The gateway logs every tool call to SQLite — re-run squad logs to audit what {agent} did.",
  "Plugins register tools, providers, channels, skills, routines, and subagents via one contract.",

  // --- Session hygiene ---
  "Long sessions auto-compress once the context fills up. You don't have to think about it.",
  "Kill a stuck turn with /stop — no need to Ctrl+C the whole gateway.",
];

function applyBranding(tip: string): string {
  const agent = brandString("agent_name", "Squad");
  return tip.replace(/\{agent\}/g, agent);
}

export function getRandomTip(): string {
  return applyBranding(TIPS[Math.floor(Math.random() * TIPS.length)]!);
}

export function getAllTips(): readonly string[] {
  return TIPS.map(applyBranding);
}
