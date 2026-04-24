import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as render from "../render.js";

/**
 * Locate docker/config.json by walking up from the CLI's install location
 * until we find the workspace file — same heuristic `lifecycle.ts` uses,
 * redeclared locally so the commands file stays self-contained.
 */
function findConfigPath(): string {
  let dir = resolve(process.env.SQUAD_REPO ?? import.meta.dirname ?? process.cwd());
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return join(dir, "docker", "config.json");
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "can't locate the squad repo. Set SQUAD_REPO=/path/to/squad or run from inside it.",
  );
}

interface PluginObjectEntry {
  path: string;
  config?: Record<string, unknown>;
}

type PluginEntry = string | PluginObjectEntry;

interface ConfigShape {
  plugins?: PluginEntry[];
  [k: string]: unknown;
}

/**
 * Resolve a friendly channel name ("discord", "slack") to the plugin entry
 * that drives it. We match the plugin path against a `channel-<name>` token —
 * the whole `packages/channel-*` convention. Strings (bare specifiers) are
 * never considered pairable since they don't carry an editable config block.
 */
function findChannelPlugin(
  config: ConfigShape,
  channel: string,
): { index: number; entry: PluginObjectEntry } | null {
  const plugins = config.plugins ?? [];
  const needle = `channel-${channel.toLowerCase()}`;
  for (let i = 0; i < plugins.length; i++) {
    const p = plugins[i];
    if (p == null || typeof p !== "object") continue;
    if (p.path.toLowerCase().includes(needle)) {
      return { index: i, entry: p };
    }
  }
  return null;
}

function readConfig(path: string): ConfigShape {
  if (!existsSync(path)) {
    throw new Error(
      `missing ${path} — run \`squad onboard\` to generate the initial config`,
    );
  }
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw) as ConfigShape;
}

function writeConfig(path: string, config: ConfigShape): void {
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getAllowList(entry: PluginObjectEntry): string[] {
  const list = entry.config?.dm_allow_list;
  return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
}

function setAllowList(entry: PluginObjectEntry, ids: string[]): void {
  entry.config = { ...(entry.config ?? {}), dm_allow_list: ids };
}

function restartHint(): string {
  // DM policy is read at plugin-load time; the live gateway won't pick up the
  // new allow-list until it boots again. Tell the user in one line.
  return "  restart to apply:  squad stop && squad start";
}

/**
 * Add a channel-native user id to the plugin's allow list. Idempotent.
 */
export function runPair(channel: string | undefined, userId: string | undefined): void {
  if (!channel || !userId) {
    throw new Error("usage: squad pair <channel> <user-id>");
  }
  const path = findConfigPath();
  const config = readConfig(path);
  const found = findChannelPlugin(config, channel);
  if (!found) {
    throw new Error(
      `no ${channel} channel plugin is installed. Run \`squad onboard\` and enable ${channel} first.`,
    );
  }
  const current = getAllowList(found.entry);
  if (current.includes(userId)) {
    render.renderInfo(`${userId} is already paired with ${channel}.`);
    render.renderInfo(`  allow list: ${current.join(", ") || "(empty)"}`);
    return;
  }
  setAllowList(found.entry, [...current, userId]);
  writeConfig(path, config);
  render.renderInfo(`paired ${userId} with ${channel}.`);
  render.renderInfo(`  allow list: ${[...current, userId].join(", ")}`);
  render.renderInfo(restartHint());
}

/**
 * Remove a user from the plugin's allow list. No-op if not present.
 */
export function runUnpair(channel: string | undefined, userId: string | undefined): void {
  if (!channel || !userId) {
    throw new Error("usage: squad unpair <channel> <user-id>");
  }
  const path = findConfigPath();
  const config = readConfig(path);
  const found = findChannelPlugin(config, channel);
  if (!found) {
    throw new Error(`no ${channel} channel plugin is installed.`);
  }
  const current = getAllowList(found.entry);
  if (!current.includes(userId)) {
    render.renderInfo(`${userId} is not on the ${channel} allow list.`);
    return;
  }
  const next = current.filter((x) => x !== userId);
  setAllowList(found.entry, next);
  writeConfig(path, config);
  render.renderInfo(`unpaired ${userId} from ${channel}.`);
  render.renderInfo(`  allow list: ${next.join(", ") || "(empty)"}`);
  render.renderInfo(restartHint());
}

/**
 * Show the allow list (and DM policy) for one or every channel.
 */
export function runPairList(channel: string | undefined): void {
  const path = findConfigPath();
  const config = readConfig(path);
  const plugins = config.plugins ?? [];
  const rows: Array<{ channel: string; policy: string; ids: string[] }> = [];
  for (const p of plugins) {
    if (p == null || typeof p !== "object") continue;
    const match = p.path.match(/channel-([a-z0-9-]+)/i);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    if (channel && name !== channel.toLowerCase()) continue;
    const cfg = (p.config ?? {}) as Record<string, unknown>;
    const policy = typeof cfg.dm_policy === "string" ? cfg.dm_policy : "allow_list";
    const ids = getAllowList(p);
    rows.push({ channel: name, policy, ids });
  }
  if (rows.length === 0) {
    render.renderInfo(
      channel
        ? `no ${channel} channel plugin is installed.`
        : "no channel plugins are installed.",
    );
    return;
  }
  for (const row of rows) {
    render.renderInfo(`${row.channel}  (dm_policy=${row.policy})`);
    if (row.ids.length === 0) {
      render.renderInfo("  (empty)");
    } else {
      for (const id of row.ids) render.renderInfo(`  ${id}`);
    }
  }
}
