import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PeerRecord } from "@squad/protocol";
import { logger as rootLogger } from "../logger.js";

const log = rootLogger.child({ component: "peers.source" });

export interface PeerSourceOptions {
  /**
   * Override for the registry path (mostly for tests). Defaults to
   * `$SQUAD_REGISTRY` when set, else `~/.squad/squads.json`.
   */
  registryPath?: string;
  /**
   * Identity of the local squad — included in the peer list with status
   * "healthy" so single-squad installs still get a non-empty result.
   */
  selfName: string;
  selfPort: number;
  selfHost?: string;
}

export interface RegistryFile {
  shared?: { registry_port?: number };
  squads?: Array<{ name: string; port: number; host?: string; build?: string; startedAt?: string }>;
}

/**
 * Best-effort peer enumeration. Reads `~/.squad/squads.json` (the file the
 * `squad mgr` CLI maintains) plus the local identity. Watches the file so
 * the gateway can publish `peers.changed` when sibling squads come and go.
 */
export class PeerSource {
  private watcher: FSWatcher | null = null;
  private cached: PeerRecord[] = [];

  constructor(private readonly opts: PeerSourceOptions) {
    this.cached = this.read();
  }

  list(): PeerRecord[] {
    return [...this.cached];
  }

  /** Refresh and return the new list. Use when you suspect the cache is stale. */
  refresh(): PeerRecord[] {
    this.cached = this.read();
    return this.list();
  }

  /**
   * Watch the registry file (if it exists) and call `onChange` with the
   * fresh peer list whenever it changes. Safe to call when no registry
   * file exists — falls back to a no-op.
   */
  start(onChange: (peers: PeerRecord[]) => void): void {
    const path = this.registryPath();
    if (!existsSync(path)) return;
    try {
      this.watcher = watch(path, () => {
        const next = this.refresh();
        onChange(next);
      });
    } catch (err) {
      log.warn({ err, path }, "peers: fs.watch unavailable — peer list will be served stale");
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  private registryPath(): string {
    if (this.opts.registryPath) return this.opts.registryPath;
    if (process.env["SQUAD_REGISTRY"]) return process.env["SQUAD_REGISTRY"];
    return join(homedir(), ".squad", "squads.json");
  }

  private read(): PeerRecord[] {
    const path = this.registryPath();
    const host = this.opts.selfHost ?? "127.0.0.1";
    const selfPeer: PeerRecord = {
      name: this.opts.selfName,
      port: this.opts.selfPort,
      url: `ws://${host}:${this.opts.selfPort}/ws`,
      status: "healthy",
      build: null,
      startedAt: null,
    };
    if (!existsSync(path)) {
      return [selfPeer];
    }
    let raw: RegistryFile;
    try {
      raw = JSON.parse(readFileSync(path, "utf-8")) as RegistryFile;
    } catch (err) {
      log.warn({ err, path }, "peers: registry read/parse failed — returning self only");
      return [selfPeer];
    }
    const out: PeerRecord[] = [];
    let sawSelf = false;
    for (const sq of raw.squads ?? []) {
      const isSelf = sq.name === this.opts.selfName && sq.port === this.opts.selfPort;
      if (isSelf) sawSelf = true;
      out.push({
        name: sq.name,
        port: sq.port,
        url: `ws://${sq.host ?? host}:${sq.port}/ws`,
        status: isSelf ? "healthy" : "unknown",
        build: sq.build ?? null,
        startedAt: sq.startedAt ?? null,
      });
    }
    if (!sawSelf) out.unshift(selfPeer);
    return out;
  }
}
