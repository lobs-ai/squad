import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
  existsSync,
} from "node:fs";
import { dirname } from "node:path";

export interface PersistedPairing {
  code: string;
  label: string;
  scopes: string[];
  /** The runtime bearer secret. Re-registered with the Authenticator on boot. */
  secret: string;
  createdAt: string;
  approvedAt: string;
  approvedBy: string | null;
  claimedAt: string | null;
}

export interface PairingPersistence {
  load(): PersistedPairing[];
  upsert(record: PersistedPairing): void;
  remove(code: string): void;
}

/**
 * Tiny JSON-file-backed persistence for approved browser pairings.
 *
 * Why a flat file rather than SQLite: this is single-row-per-pairing, the
 * total volume is tiny, and we want a human-eyeballable artifact at
 * `<data_dir>/pairings.json` so an operator can `cat` it (and prune by
 * hand if a browser is lost). Writes go through a temp-file + rename so
 * a crash mid-write can't corrupt the registry.
 */
export class JsonFilePairingPersistence implements PairingPersistence {
  constructor(private readonly path: string) {}

  load(): PersistedPairing[] {
    if (!existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch {
      return [];
    }
    if (raw.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(raw) as { pairings?: PersistedPairing[] };
      return Array.isArray(parsed.pairings) ? parsed.pairings : [];
    } catch {
      return [];
    }
  }

  upsert(record: PersistedPairing): void {
    const list = this.load();
    const idx = list.findIndex((r) => r.code === record.code);
    if (idx >= 0) list[idx] = record;
    else list.push(record);
    this.write(list);
  }

  remove(code: string): void {
    const list = this.load();
    const next = list.filter((r) => r.code !== code);
    if (next.length === list.length) return;
    this.write(next);
  }

  private write(list: PersistedPairing[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    const fd = openSync(tmp, "w");
    try {
      const body = JSON.stringify({ pairings: list }, null, 2) + "\n";
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

/** In-memory shim for tests. */
export class MemoryPairingPersistence implements PairingPersistence {
  private records: PersistedPairing[] = [];
  load(): PersistedPairing[] {
    return [...this.records];
  }
  upsert(record: PersistedPairing): void {
    const i = this.records.findIndex((r) => r.code === record.code);
    if (i >= 0) this.records[i] = record;
    else this.records.push(record);
  }
  remove(code: string): void {
    this.records = this.records.filter((r) => r.code !== code);
  }
}
