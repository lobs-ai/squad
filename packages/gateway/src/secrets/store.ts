import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/**
 * File-backed secret store, mode 0600. Used by plugin install to persist
 * literal secret values the user typed into the configure form (Discord
 * bot token, OpenAI key, …) without making them edit `.env` or guess
 * env-var names.
 *
 * On boot, {@link mergeIntoProcessEnv} merges the stored secrets into
 * `process.env` so plugins that read `process.env[name]` keep working
 * unchanged. Existing env vars win — Docker/Kubernetes overrides aren't
 * shadowed.
 *
 * Storage shape:
 *   { "DISCORD_BOT_TOKEN": "abc…", "OPENAI_API_KEY": "sk-…" }
 *
 * Keys are env-var names so the on-disk format is self-documenting and
 * direct edits remain possible.
 */
export class SecretStore {
  private cache: Record<string, string> | null = null;

  constructor(private readonly path: string) {}

  /**
   * Load (or re-load) the file. Returns an empty object when the file
   * doesn't exist yet — that's the first-install case, not an error.
   */
  load(): Record<string, string> {
    if (!existsSync(this.path)) {
      this.cache = {};
      return this.cache;
    }
    const raw = readFileSync(this.path, "utf8").trim();
    if (raw.length === 0) {
      this.cache = {};
      return this.cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`secrets store at ${this.path} is not valid JSON`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`secrets store at ${this.path} must be a JSON object`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== "string") continue;
      out[k] = v;
    }
    this.cache = out;
    return out;
  }

  /** Read-through; loads on first access. */
  list(): Record<string, string> {
    if (!this.cache) this.load();
    return { ...(this.cache ?? {}) };
  }

  has(name: string): boolean {
    if (!this.cache) this.load();
    return Boolean(this.cache && name in this.cache);
  }

  get(name: string): string | undefined {
    if (!this.cache) this.load();
    return this.cache?.[name];
  }

  /**
   * Set (or replace) a secret and persist to disk. The mutation is also
   * reflected into `process.env` so plugins loaded later in the same boot
   * see the new value without a restart.
   */
  set(name: string, value: string): void {
    if (!this.cache) this.load();
    this.cache![name] = value;
    this.persist();
    process.env[name] = value;
  }

  /**
   * Remove a secret. We don't unset `process.env` because the user may
   * have configured the same name explicitly via the shell — let them
   * restart if they truly want it gone in-process.
   */
  unset(name: string): void {
    if (!this.cache) this.load();
    if (!this.cache || !(name in this.cache)) return;
    delete this.cache[name];
    this.persist();
  }

  /**
   * Merge stored secrets into `process.env`. Explicit env vars win — we
   * never overwrite a value the operator deliberately exported (e.g. the
   * docker-compose `environment:` block is authoritative).
   */
  mergeIntoProcessEnv(): { applied: string[]; skipped: string[] } {
    const applied: string[] = [];
    const skipped: string[] = [];
    for (const [k, v] of Object.entries(this.list())) {
      if (process.env[k] !== undefined && process.env[k] !== "") {
        skipped.push(k);
        continue;
      }
      process.env[k] = v;
      applied.push(k);
    }
    return { applied, skipped };
  }

  private persist(): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const text = JSON.stringify(this.cache ?? {}, null, 2) + "\n";
    writeFileSync(this.path, text, "utf8");
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // chmod isn't supported on every FS (Windows mounts in WSL, certain
      // bind mounts) — best-effort. The user is in their own home dir on
      // posix, where this works.
    }
  }
}
