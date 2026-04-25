import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { REGISTRY_PATH, SQUAD_HOME } from "./paths.js";

export interface Squad {
  name: string;
  /** Host-side port mapped to the container's internal 8080. */
  port: number;
}

export interface Registry {
  /**
   * Absolute path to the squad source repo (the dir containing pnpm-workspace.yaml
   * + Dockerfile). Used as the docker `build.context`. Recorded on first regen
   * so the generated compose file is reproducible across mgr invocations.
   */
  build_context: string;
  squads: Squad[];
  shared: {
    /** Host-side port for the shared searxng container. */
    searxng_port: number;
  };
}

export const DEFAULT_REGISTRY: Registry = {
  build_context: "",
  squads: [],
  shared: { searxng_port: 8888 },
};

export function loadRegistry(): Registry {
  if (!existsSync(REGISTRY_PATH)) return { ...DEFAULT_REGISTRY };
  const raw = readFileSync(REGISTRY_PATH, "utf8");
  const parsed = JSON.parse(raw) as Partial<Registry>;
  return {
    build_context: parsed.build_context ?? "",
    squads: Array.isArray(parsed.squads) ? parsed.squads : [],
    shared: { ...DEFAULT_REGISTRY.shared, ...(parsed.shared ?? {}) },
  };
}

export function saveRegistry(reg: Registry): void {
  if (!existsSync(SQUAD_HOME)) mkdirSync(SQUAD_HOME, { recursive: true });
  if (!existsSync(dirname(REGISTRY_PATH))) {
    mkdirSync(dirname(REGISTRY_PATH), { recursive: true });
  }
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

/**
 * Pick the next free port at or above `start`, skipping anything already
 * claimed by another squad in the registry. We don't probe the host with
 * net.connect — collisions with non-squad processes surface as a docker error
 * at `mgr start`, which is loud and easy to fix by editing the squad's port.
 */
export function findFreePort(reg: Registry, start = 8080): number {
  const taken = new Set(reg.squads.map((s) => s.port));
  taken.add(reg.shared.searxng_port);
  let p = start;
  while (taken.has(p)) p++;
  return p;
}

export function getSquad(reg: Registry, name: string): Squad | undefined {
  return reg.squads.find((s) => s.name === name);
}

export function requireSquad(reg: Registry, name: string): Squad {
  const s = getSquad(reg, name);
  if (!s) throw new Error(`unknown squad: ${name}. Run 'squad mgr ls' to see registered squads.`);
  return s;
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export function validateName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new Error(
      `invalid squad name '${name}'. Must be lowercase letters/digits/_/-, start alphanumeric, ≤31 chars.`,
    );
  }
}
