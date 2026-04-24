import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { C, color, fg } from "../ui/colors.js";
import { roleColor } from "../ui/skin.js";

/**
 * Find the repo root (dir containing pnpm-workspace.yaml) so we can shell out
 * to scripts/start.sh, stop.sh, status.sh from a globally-installed binary.
 */
function findRepoRoot(): string {
  // When installed via `pnpm link --global` the binary lives in
  // packages/client-cli/dist/cli.js — walk up until we see the workspace file.
  let dir = resolve(process.env.SQUAD_REPO ?? import.meta.dirname ?? process.cwd());
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "can't locate the squad repo. Set SQUAD_REPO=/path/to/squad or run from inside it.",
  );
}

function runScript(name: string, args: string[]): Promise<number> {
  const root = findRepoRoot();
  const path = join(root, "scripts", name);
  if (!existsSync(path)) throw new Error(`missing script: ${path}`);
  return new Promise((resolveP) => {
    const child = spawn(path, args, { stdio: "inherit", cwd: root });
    child.on("exit", (code) => resolveP(code ?? 0));
  });
}

export async function startGateway(args: string[]): Promise<void> {
  const code = await runScript("start.sh", args);
  if (code !== 0) process.exitCode = code;
}

export async function stopGateway(): Promise<void> {
  const code = await runScript("stop.sh", []);
  if (code !== 0) process.exitCode = code;
}

// Log level → color + rank. Used to colorize and filter pino output.
const LEVEL_INFO: Record<
  string,
  { label: string; role: string; rank: number }
> = {
  trace: { label: "TRACE", role: "muted", rank: 10 },
  debug: { label: "DEBUG", role: "muted", rank: 20 },
  info: { label: "INFO ", role: "ok", rank: 30 },
  warn: { label: "WARN ", role: "warn", rank: 40 },
  error: { label: "ERROR", role: "err", rank: 50 },
  fatal: { label: "FATAL", role: "err", rank: 60 },
};

function pinoLevelName(level: number | string): string {
  if (typeof level === "string") return level;
  if (level >= 60) return "fatal";
  if (level >= 50) return "error";
  if (level >= 40) return "warn";
  if (level >= 30) return "info";
  if (level >= 20) return "debug";
  return "trace";
}

/** Format one parsed pino log object into a colored line. */
function formatPinoLine(obj: Record<string, unknown>): string {
  const levelName = pinoLevelName(
    (obj.level as number | string | undefined) ?? 30,
  );
  const info = LEVEL_INFO[levelName] ?? LEVEL_INFO.info!;
  const muted = fg(roleColor("muted"));
  const levelColor = fg(roleColor(info.role));

  const timeRaw = (obj.time as string | undefined) ?? "";
  // pino isoTime → "2024-..." — trim to HH:MM:SS for readability.
  const time = timeRaw.length >= 19 ? timeRaw.slice(11, 19) : timeRaw;

  const msg = (obj.msg as string | undefined) ?? "";
  const source = (obj.source as string | undefined) ?? (obj.service as string | undefined);

  // Extra fields — everything not in the reserved set — rendered as k=v tail.
  const reserved = new Set(["level", "time", "msg", "service", "source", "name", "pid", "hostname"]);
  const extras: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (reserved.has(k)) continue;
    if (v === undefined) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    extras.push(`${muted}${k}${C.RESET}=${s}`);
  }
  const extraStr = extras.length ? " " + extras.join(" ") : "";
  const srcStr = source ? ` ${color(source, muted)}` : "";
  return `${color(time, muted)} ${color(info.label, levelColor, C.BOLD)}${srcStr}  ${msg}${extraStr}`;
}

/**
 * Pretty-print logs from the gateway (docker or local). Accepts --json for
 * raw passthrough, --level <name> to drop lines below a threshold.
 */
export async function gatewayLogs(args: string[]): Promise<void> {
  // Parse our own flags before forwarding the rest to status.sh.
  const flags: string[] = [];
  let raw = false;
  let minLevel = 0;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") {
      raw = true;
    } else if (a === "--level" && args[i + 1]) {
      const name = args[++i]!.toLowerCase();
      const info = LEVEL_INFO[name];
      if (info) minLevel = info.rank;
    } else if (a !== undefined) {
      flags.push(a);
    }
  }

  const root = findRepoRoot();
  const path = join(root, "scripts", "status.sh");
  if (!existsSync(path)) throw new Error(`missing script: ${path}`);

  const child = spawn(path, ["logs", ...flags], {
    cwd: root,
    stdio: ["inherit", "pipe", "inherit"],
  });

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (raw) {
      process.stdout.write(line + "\n");
      return;
    }
    const trimmed = line.trim();
    // docker compose prefixes lines with container name; strip to get JSON.
    const jsonStart = trimmed.indexOf("{");
    if (jsonStart === -1 || !trimmed.endsWith("}")) {
      process.stdout.write(line + "\n");
      return;
    }
    try {
      const obj = JSON.parse(trimmed.slice(jsonStart)) as Record<string, unknown>;
      const levelName = pinoLevelName(
        (obj.level as number | string | undefined) ?? 30,
      );
      const rank = LEVEL_INFO[levelName]?.rank ?? 30;
      if (rank < minLevel) return;
      process.stdout.write(formatPinoLine(obj) + "\n");
    } catch {
      // Not JSON — just pass through.
      process.stdout.write(line + "\n");
    }
  });

  await new Promise<void>((resolveP) => {
    child.on("exit", (code) => {
      if (code && code !== 0) process.exitCode = code;
      resolveP();
    });
  });
}

/**
 * Run the onboarding wizard (scripts/setup.mjs) in the current terminal.
 * Inherits stdio so the user can interact with its prompts.
 */
export async function runOnboard(args: string[]): Promise<void> {
  const root = findRepoRoot();
  const script = join(root, "scripts", "setup.mjs");
  if (!existsSync(script)) throw new Error(`missing: ${script}`);
  const code = await new Promise<number>((resolveP) => {
    const child = spawn("node", [script, ...args], { stdio: "inherit", cwd: root });
    child.on("exit", (c) => resolveP(c ?? 0));
  });
  if (code !== 0) process.exitCode = code;
}
