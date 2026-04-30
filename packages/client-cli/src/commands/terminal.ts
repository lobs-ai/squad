import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { CURRENT_FILE } from "../mgr/paths.js";
import { getSquad, loadRegistry } from "../mgr/registry.js";
import { isRunning, listRunningSquads } from "../mgr/discovery.js";

/**
 * Pick which squad to attach to. Mirrors resolveEnv()'s precedence but
 * returns just the name (terminal access doesn't need a WS token).
 */
function resolveSquadName(explicit?: string): string {
  if (explicit) return explicit;
  if (process.env.SQUAD_NAME) return process.env.SQUAD_NAME;
  if (existsSync(CURRENT_FILE)) {
    const cur = readFileSync(CURRENT_FILE, "utf8").trim();
    if (cur) return cur;
  }

  const reg = loadRegistry();
  const running = listRunningSquads().filter((r) => isRunning(r.status));
  if (running.length === 1) return running[0]!.name;
  if (running.length > 1) {
    const names = running.map((r) => r.name).join(", ");
    throw new Error(
      `multiple squads running (${names}). Pick one: squad terminal <name>, --squad <name>, or 'squad mgr use <name>'.`,
    );
  }
  if (reg.squads.length === 1) return reg.squads[0]!.name;
  if (reg.squads.length > 1) {
    const names = reg.squads.map((s) => s.name).join(", ");
    throw new Error(
      `multiple squads registered (${names}) but none selected. Pass squad terminal <name> or 'squad mgr use <name>'.`,
    );
  }
  throw new Error("no squads registered. Run 'squad onboard' to create one.");
}

/**
 * `squad terminal [name] [-- cmd ...]` — exec into the squad-<name>
 * container with an interactive shell (or run a one-shot command after `--`).
 */
export async function runTerminal(args: string[]): Promise<void> {
  // Split off anything after `--` as the command to run; default to bash.
  const dashIdx = args.indexOf("--");
  const head = dashIdx === -1 ? args : args.slice(0, dashIdx);
  const cmd = dashIdx === -1 ? [] : args.slice(dashIdx + 1);

  const explicit = head.shift();
  const name = resolveSquadName(explicit);
  const container = `squad-${name}`;

  // Confirm the container is up — `docker exec` against a stopped container
  // produces a cryptic error; this gives a useful suggestion instead.
  const running = listRunningSquads();
  const match = running.find((r) => r.name === name);
  if (!match || !isRunning(match.status)) {
    throw new Error(
      `squad '${name}' is not running. Start it with: squad mgr start ${name}`,
    );
  }

  // Prefer bash, but fall back to sh inside the container if bash is missing.
  // The wrapper exec's into whichever is available so the user gets a real shell.
  const shellCmd =
    cmd.length > 0
      ? cmd
      : ["sh", "-c", "exec bash 2>/dev/null || exec sh"];

  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const dockerArgs = [
    "exec",
    ...(isTTY ? ["-it"] : ["-i"]),
    container,
    ...shellCmd,
  ];

  const code = await new Promise<number>((resolveP) => {
    const child = spawn("docker", dockerArgs, { stdio: "inherit" });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        process.stderr.write("docker not found on PATH. Install Docker (or OrbStack) and try again.\n");
        resolveP(127);
        return;
      }
      process.stderr.write(`docker exec failed: ${err.message}\n`);
      resolveP(1);
    });
    child.on("exit", (c) => resolveP(c ?? 0));
  });
  if (code !== 0) process.exitCode = code;
}
