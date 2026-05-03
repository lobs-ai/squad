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
import type { ApprovalRule } from "@squad/protocol";
import { logger as rootLogger } from "../logger.js";

const log = rootLogger.child({ component: "approvals.rules-persist" });

export interface ApprovalRulePersistence {
  load(): ApprovalRule[];
  upsert(rule: ApprovalRule): void;
  remove(id: string): void;
}

/**
 * JSON-file-backed persistence for "always allow" approval rules. Same
 * temp-file-then-rename pattern as the pairing store so a crash mid-write
 * can't corrupt the registry. Lives at `<data_dir>/approval-rules.json`
 * so an operator can `cat` it (and prune by hand if needed).
 */
export class JsonFileApprovalRulePersistence implements ApprovalRulePersistence {
  constructor(private readonly path: string) {}

  load(): ApprovalRule[] {
    if (!existsSync(this.path)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf-8");
    } catch (err) {
      log.warn({ err, path: this.path }, "approval rules: read failed — treating as empty");
      return [];
    }
    if (raw.trim().length === 0) return [];
    try {
      const parsed = JSON.parse(raw) as { rules?: ApprovalRule[] };
      return Array.isArray(parsed.rules) ? parsed.rules : [];
    } catch (err) {
      log.error(
        { err, path: this.path, bytes: raw.length },
        "approval rules: JSON parse failed — registry will load empty",
      );
      return [];
    }
  }

  upsert(rule: ApprovalRule): void {
    const list = this.load();
    const idx = list.findIndex((r) => r.id === rule.id);
    if (idx >= 0) list[idx] = rule;
    else list.push(rule);
    this.write(list);
  }

  remove(id: string): void {
    const list = this.load();
    const next = list.filter((r) => r.id !== id);
    if (next.length === list.length) return;
    this.write(next);
  }

  private write(list: ApprovalRule[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    const fd = openSync(tmp, "w");
    try {
      const body = JSON.stringify({ rules: list }, null, 2) + "\n";
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
  }
}

/** In-memory shim for tests. */
export class MemoryApprovalRulePersistence implements ApprovalRulePersistence {
  private records: ApprovalRule[] = [];
  load(): ApprovalRule[] {
    return [...this.records];
  }
  upsert(rule: ApprovalRule): void {
    const i = this.records.findIndex((r) => r.id === rule.id);
    if (i >= 0) this.records[i] = rule;
    else this.records.push(rule);
  }
  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
  }
}
