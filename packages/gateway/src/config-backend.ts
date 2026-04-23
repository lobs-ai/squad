import { readFileSync, writeFileSync } from "node:fs";
import {
  type ConfigBackend,
  type ConfigPath,
  splitPath,
  flattenLeafPaths,
} from "@squad/tools";
import { configSchema, type Config } from "./config.js";

export interface JsonConfigBackendOptions {
  /** Absolute path to the config.json file. */
  path: string;
  /**
   * Called after a successful mutation with the new parsed config. Use this
   * to update in-memory references so subsequent reads reflect the change.
   * Note: long-lived components (pools, queues, HTTP server) still need a
   * restart for structural config to take effect.
   */
  onUpdate?: (config: Config) => void;
  /** Indentation used when writing JSON. Two spaces by default. */
  indent?: number;
}

/**
 * Reads and writes config.json. Every mutation re-validates the resulting
 * object through `configSchema` before writing to disk, so a bad input
 * never corrupts the file. JSON doesn't carry comments, so we don't need
 * the Document-round-trip trick the old YAML backend used.
 */
export class JsonConfigBackend implements ConfigBackend {
  private readonly indent: number;
  constructor(private readonly opts: JsonConfigBackendOptions) {
    this.indent = opts.indent ?? 2;
  }

  async get(): Promise<Record<string, unknown>> {
    const raw = readFileSync(this.opts.path, "utf8");
    const trimmed = raw.trim();
    if (trimmed.length === 0) return {};
    const parsed = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`${this.opts.path}: expected a JSON object at the top level`);
    }
    return parsed as Record<string, unknown>;
  }

  async getValue(path: ConfigPath): Promise<unknown> {
    const obj = await this.get();
    return readDeep(obj, splitPath(path));
  }

  async setValue(path: ConfigPath, value: unknown): Promise<Record<string, unknown>> {
    const segments = splitPath(path);
    if (segments.length === 0) {
      throw new Error("set_config: `path` must be non-empty");
    }
    const current = await this.get();
    const next = setDeep(current, segments, value);
    return this.validateAndPersist(next);
  }

  async unsetValue(path: ConfigPath): Promise<Record<string, unknown>> {
    const segments = splitPath(path);
    if (segments.length === 0) {
      throw new Error("unset_config: `path` must be non-empty");
    }
    const current = await this.get();
    const { next, existed } = unsetDeep(current, segments);
    if (!existed) {
      throw new Error(`unset_config: path "${path}" is not set`);
    }
    return this.validateAndPersist(next);
  }

  async listPaths(): Promise<ConfigPath[]> {
    const obj = await this.get();
    return flattenLeafPaths(obj);
  }

  private validateAndPersist(candidate: Record<string, unknown>): Record<string, unknown> {
    // configSchema throws on invalid input; nothing is written if this fails.
    const validated = configSchema.parse(candidate);
    const text = JSON.stringify(candidate, null, this.indent) + "\n";
    writeFileSync(this.opts.path, text, "utf8");
    this.opts.onUpdate?.(validated);
    return candidate;
  }
}

// ── Deep get/set/unset helpers (array + object, copy-on-write) ────────────────

function readDeep(obj: unknown, segments: Array<string | number>): unknown {
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object" || Array.isArray(cur)) return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function setDeep(
  root: Record<string, unknown>,
  segments: Array<string | number>,
  value: unknown,
): Record<string, unknown> {
  const clone: Record<string, unknown> = { ...root };
  let parent: Record<string, unknown> | unknown[] = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const nextSegIsNumber = typeof segments[i + 1] === "number";
    if (typeof seg === "number") {
      if (!Array.isArray(parent)) {
        throw new Error(`Expected array at segment ${i}`);
      }
      const arrParent = parent as unknown[];
      const existing = arrParent[seg];
      const container =
        existing !== undefined
          ? Array.isArray(existing)
            ? [...(existing as unknown[])]
            : { ...(existing as Record<string, unknown>) }
          : nextSegIsNumber
            ? []
            : {};
      arrParent[seg] = container;
      parent = container as Record<string, unknown> | unknown[];
    } else {
      if (Array.isArray(parent)) {
        throw new Error(`Expected object at segment ${i}`);
      }
      const objParent = parent as Record<string, unknown>;
      const existing = objParent[seg];
      const container =
        existing !== undefined
          ? Array.isArray(existing)
            ? [...(existing as unknown[])]
            : typeof existing === "object" && existing !== null
              ? { ...(existing as Record<string, unknown>) }
              : nextSegIsNumber
                ? []
                : {}
          : nextSegIsNumber
            ? []
            : {};
      objParent[seg] = container;
      parent = container as Record<string, unknown> | unknown[];
    }
  }
  const last = segments[segments.length - 1]!;
  if (typeof last === "number") {
    if (!Array.isArray(parent)) throw new Error("Expected array at final segment");
    (parent as unknown[])[last] = value;
  } else {
    if (Array.isArray(parent)) throw new Error("Expected object at final segment");
    (parent as Record<string, unknown>)[last] = value;
  }
  return clone;
}

function unsetDeep(
  root: Record<string, unknown>,
  segments: Array<string | number>,
): { next: Record<string, unknown>; existed: boolean } {
  const clone: Record<string, unknown> = { ...root };
  let parent: Record<string, unknown> | unknown[] = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    let existing: unknown;
    if (typeof seg === "number") {
      if (!Array.isArray(parent)) return { next: root, existed: false };
      existing = (parent as unknown[])[seg];
      if (existing === undefined) return { next: root, existed: false };
      const container = Array.isArray(existing)
        ? [...(existing as unknown[])]
        : { ...(existing as Record<string, unknown>) };
      (parent as unknown[])[seg] = container;
      parent = container;
    } else {
      if (Array.isArray(parent)) return { next: root, existed: false };
      existing = (parent as Record<string, unknown>)[seg];
      if (existing === undefined) return { next: root, existed: false };
      const container = Array.isArray(existing)
        ? [...(existing as unknown[])]
        : typeof existing === "object" && existing !== null
          ? { ...(existing as Record<string, unknown>) }
          : existing;
      (parent as Record<string, unknown>)[seg] = container;
      parent = container as Record<string, unknown> | unknown[];
    }
  }
  const last = segments[segments.length - 1]!;
  if (typeof last === "number") {
    if (!Array.isArray(parent)) return { next: root, existed: false };
    const arr = parent as unknown[];
    if (last >= arr.length || arr[last] === undefined) return { next: root, existed: false };
    arr.splice(last, 1);
    return { next: clone, existed: true };
  }
  if (Array.isArray(parent)) return { next: root, existed: false };
  const obj = parent as Record<string, unknown>;
  if (!(last in obj)) return { next: root, existed: false };
  delete obj[last];
  return { next: clone, existed: true };
}
