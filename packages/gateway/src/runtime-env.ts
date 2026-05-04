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
   * Bind host the gateway listens on. Usually `0.0.0.0` in containers and
   * `127.0.0.1`/`localhost` in dev. Reported as-configured — the section
   * renderer is responsible for picking a sensible host to put in URLs.
   */
  serverHost: string;
  /** TCP port the gateway HTTP/WS server listens on. */
  serverPort: number;
  /**
   * Public, browser-pasteable base URL for the gateway. In containerised
   * deployments this is the *host-mapped* URL (e.g. http://localhost:8123),
   * which differs from `serverHost:serverPort` (always 0.0.0.0:8080 inside
   * the container). The squad CLI passes this in via `SQUAD_BASE_URL`; the
   * gateway falls back to `gatewayBaseUrl(serverHost, serverPort)` for
   * native runs. Always use this — never compose a URL from serverPort.
   */
  publicBaseUrl: string;
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
  serverHost: string;
  serverPort: number;
}): RuntimeEnvironment {
  // Operator-set SQUAD_BASE_URL wins (containers get it from compose; reverse
  // proxies override it explicitly). Fall back to the listen host:port for
  // bare-metal / dev runs. boot() also publishes it into process.env if it
  // wasn't already, so plugins see the same value when they register.
  const envBase = process.env.SQUAD_BASE_URL?.trim();
  const publicBaseUrl =
    envBase && envBase.length > 0
      ? envBase.replace(/\/$/, "")
      : gatewayBaseUrl(args.serverHost, args.serverPort);
  return {
    containerKind: detectContainer(),
    os: platform(),
    osRelease: release(),
    hostname: hostname(),
    dataDir: args.dataDir,
    workspaceDir: args.workspaceDir,
    squadName: args.squadName,
    cwd: process.cwd(),
    serverHost: args.serverHost,
    serverPort: args.serverPort,
    publicBaseUrl,
    envFilePath: findEnvFile(args.dataDir),
  };
}

/**
 * Pick a host the user can actually paste into a browser. The bind address
 * may be `0.0.0.0` / `::` / empty — those work for `listen()` but resolve
 * to nothing useful in a URL. Fall back to `localhost` in those cases so
 * the agent never tells the user "open http://0.0.0.0:<port>".
 */
function urlHost(bindHost: string): string {
  const h = bindHost.trim();
  if (!h || h === "0.0.0.0" || h === "::" || h === "[::]") return "localhost";
  return h;
}

/**
 * Compose a browser-pasteable base URL for the gateway from its listen
 * address. Used both by the runtime-env section renderer and by the boot
 * sequence that publishes `SQUAD_BASE_URL` into `process.env` before
 * plugins load (so plugins never need to hardcode a port to compute their
 * own callback URLs).
 */
export function gatewayBaseUrl(serverHost: string, serverPort: number): string {
  return `http://${urlHost(serverHost)}:${serverPort}`;
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
    `- **Gateway listen (internal):** ${env.serverHost}:${env.serverPort}`,
    `- **Public base URL:** ${env.publicBaseUrl} (use this for any URL you give the user — dashboard links, OAuth redirect URIs, webhooks. Never substitute the internal port above; in containers it's mapped.)`,
    `- **Data dir:** ${env.dataDir}`,
    `- **Workspace dir:** ${env.workspaceDir}`,
    `- **Process cwd:** ${env.cwd}`,
    `- **.env file:** ${env.envFilePath ?? "(none detected — operator may set env vars another way)"}`,
    "",
    "Use this when the user asks setup-style questions (\"where do I put X\", \"how is this running\", \"what's the dashboard URL\"). When you give the user a URL — dashboard, OAuth callback, webhook — copy the **Public base URL** above verbatim; do NOT compose a URL from the internal listen port. To persist environment variables on this gateway, **never tell the user to edit `.env` themselves** — use one of these tools:",
    "  - `plugin_install` with a `secrets` map → for plugin-declared fields. Same store, plus rollback on failure.",
    "  - `set_env(name, value)` → for everything else (API keys, tokens, db URLs, anything that something here reads from `process.env`). Available on every session.",
    "Both write to a 0600 secrets file under the data dir AND inject into `process.env` immediately, so the next read picks up the value without a restart.",
  ];
  return lines.join("\n");
}
