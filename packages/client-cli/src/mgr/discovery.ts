import { execSync } from "node:child_process";

/**
 * One running squad container, as reported by `docker ps`. The label values
 * are the source of truth — the registry can drift if the user hand-edits
 * containers, but labels are baked into the running container by compose.
 */
export interface RunningSquad {
  name: string;
  port: number;
  containerId: string;
  status: string; // docker's "Up 2 hours", "Restarting", etc.
  health: string; // "healthy" | "unhealthy" | "starting" | "" (none)
}

/**
 * Query docker for all containers with the lobs.squad.name label, regardless
 * of running state. Returns [] if docker isn't installed or the daemon is
 * unreachable — callers can decide whether that's an error.
 */
export function listRunningSquads(): RunningSquad[] {
  let raw: string;
  try {
    // --format=json emits one container per line (jsonl), not a JSON array.
    // Works on docker ≥ 23 and the docker CLI for OrbStack / Podman-compose.
    raw = execSync(
      `docker ps -a --filter label=lobs.squad.name --format '{{json .}}'`,
      { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" },
    );
  } catch {
    return [];
  }

  const out: RunningSquad[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    // docker formats Labels as "k=v,k=v"
    const labels = parseLabels((obj.Labels as string | undefined) ?? "");
    const name = labels["lobs.squad.name"];
    if (!name) continue;
    const portStr = labels["lobs.squad.port"];
    const port = portStr ? Number(portStr) : 0;
    const status = String(obj.Status ?? "");
    const health = healthFromStatus(status);
    out.push({
      name,
      port,
      containerId: String(obj.ID ?? ""),
      status,
      health,
    });
  }
  return out;
}

function parseLabels(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function healthFromStatus(status: string): string {
  const m = status.match(/\((healthy|unhealthy|starting|health: starting)\)/);
  if (!m) return "";
  return m[1]!.replace("health: ", "");
}

/** Whether a docker status string indicates the container is up. */
export function isRunning(status: string): boolean {
  return status.startsWith("Up");
}
