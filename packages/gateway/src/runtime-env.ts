import { existsSync, readFileSync } from "node:fs";
import { hostname, platform, release } from "node:os";

/**
 * Snapshot of the runtime environment the gateway is hosted in. Injected
 * into every chat turn's system prompt so the agent doesn't have to ask
 * "where am I running?" before suggesting setup steps. Cheap to compute
 * (one stat + one tiny read) — we still cache it at boot.
 */
export interface RuntimeEnvironment {
  /** "docker" | "kubernetes" | "native". */
  containerKind: "docker" | "kubernetes" | "native";
  /** Output of `os.platform()` (linux | darwin | win32 | …). */
  os: string;
  /** `os.release()` — kernel version string. */
  osRelease: string;
  /** Container or host name, whichever we can read. */
  hostname: string;
  /** Squad's data directory on this host. */
  dataDir: string;
  /** Squad's workspace directory (agent home). */
  workspaceDir: string;
  /** Profile / squad name (multi-squad mode). */
  squadName: string;
  /** Process cwd at boot — useful for relative-path discussion. */
  cwd: string;
  /**
   * Path to a `.env`-style file the operator can edit on the host. Detected
   * heuristically; null when we can't find one. The agent should NOT
   * recommend editing this for plugin secrets — that's what the secret
   * store is for. Reported here so the agent can answer "where's the .env"
   * if asked, and so it knows there is one to inherit env vars from.
   */
  envFilePath: string | null;
}

/**
 * Detect whether we're inside Docker. Two cheap signals:
 *   - `/.dockerenv` exists (created by the Docker engine).
 *   - `/proc/1/cgroup` contains `docker` or `kubepods`.
 * Kubernetes is reported separately so the agent can speak the right
 * vocabulary (env-from configmaps, secret refs, etc.) when it gets there.
 */
function detectContainer(): RuntimeEnvironment["containerKind"] {
  if (existsSync("/.dockerenv")) return "docker";
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (cgroup.includes("kubepods")) return "kubernetes";
    if (cgroup.includes("docker") || cgroup.includes("containerd")) return "docker";
  } catch {
    // /proc not present (macOS, Windows) → no container signal here.
  }
  return "native";
}

function findEnvFile(dataDir: string): string | null {
  // Order: explicit env override → data_dir/.env → cwd/.env → squad-default
  // location. Only return the first one that actually exists.
  const candidates = [
    process.env.SQUAD_ENV_FILE,
    `${dataDir}/.env`,
    `${process.cwd()}/.env`,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return p;
    } catch {
      /* permission errors → skip */
    }
  }
  return null;
}

export function captureRuntimeEnvironment(args: {
  dataDir: string;
  workspaceDir: string;
  squadName: string;
}): RuntimeEnvironment {
  return {
    containerKind: detectContainer(),
    os: platform(),
    osRelease: release(),
    hostname: hostname(),
    dataDir: args.dataDir,
    workspaceDir: args.workspaceDir,
    squadName: args.squadName,
    cwd: process.cwd(),
    envFilePath: findEnvFile(args.dataDir),
  };
}

/**
 * Render as a system-prompt section. Compact — one labeled line per fact —
 * since this rides on every turn. Skip nothing: the agent picks what's
 * relevant per question.
 */
export function renderRuntimeEnvironmentSection(env: RuntimeEnvironment): string {
  const lines: string[] = [
    "## Runtime environment",
    "",
    `- **Hosting:** ${env.containerKind} (${env.os} ${env.osRelease})`,
    `- **Squad name:** ${env.squadName}`,
    `- **Hostname:** ${env.hostname}`,
    `- **Data dir:** ${env.dataDir}`,
    `- **Workspace dir:** ${env.workspaceDir}`,
    `- **Process cwd:** ${env.cwd}`,
    `- **.env file:** ${env.envFilePath ?? "(none detected — operator may set env vars another way)"}`,
    "",
    "Use this when the user asks setup-style questions (\"where do I put X\", \"how is this running\"). To persist environment variables on this gateway, **never tell the user to edit `.env` themselves** — use one of these tools:",
    "  - `plugin_install` with a `secrets` map → for plugin-declared fields. Same store, plus rollback on failure.",
    "  - `set_env(name, value)` → for everything else (API keys, tokens, db URLs, anything that something here reads from `process.env`). Available on every session.",
    "Both write to a 0600 secrets file under the data dir AND inject into `process.env` immediately, so the next read picks up the value without a restart.",
  ];
  return lines.join("\n");
}
