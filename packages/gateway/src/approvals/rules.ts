import { randomUUID } from "node:crypto";
import type { ApprovalPolicy } from "@squad/plugin-sdk";
import type { ApprovalRule } from "@squad/protocol";
import type { ApprovalRulePersistence } from "./rules-persist.js";

export interface ApprovalRuleStoreCallbacks {
  onAdded?: (rule: ApprovalRule) => void;
  onRemoved?: (ruleId: string) => void;
}

export interface AddRuleInput {
  toolName: string;
  /** `null` matches every target for this tool. */
  target: string | null;
  label?: string | null;
  createdBy?: string | null;
}

/**
 * Resolve the target string from a tool input. Mirrors the dashboard's
 * `formatToolTarget` so a rule recorded from the UI matches the same string
 * the gateway derives at request time. Truncation is intentionally NOT
 * applied here — rules need the full path/command to be precise; the
 * dashboard's truncation is purely cosmetic.
 */
export function targetFromInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "target", "command", "url", "query"]) {
    const v = i[key];
    if (typeof v === "string") return v;
  }
  return null;
}

/**
 * Persistent allow-list of (toolName, target) pairs the user has marked as
 * "always allow". The store is in-memory for fast lookups but mirrors every
 * mutation to disk via `ApprovalRulePersistence`.
 */
export class ApprovalRuleStore {
  private rules: ApprovalRule[] = [];

  constructor(
    private readonly persistence: ApprovalRulePersistence,
    private readonly cb: ApprovalRuleStoreCallbacks = {},
  ) {
    this.rules = persistence.load();
  }

  list(): ApprovalRule[] {
    return [...this.rules].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  add(input: AddRuleInput): ApprovalRule {
    // Collapse exact duplicates so the user can click "always allow" twice
    // without growing the list.
    const existing = this.rules.find(
      (r) => r.toolName === input.toolName && r.target === input.target,
    );
    if (existing) return existing;
    const rule: ApprovalRule = {
      id: "ar_" + randomUUID().slice(0, 8),
      toolName: input.toolName,
      target: input.target,
      label: input.label ?? null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null,
    };
    this.rules.push(rule);
    this.persistence.upsert(rule);
    this.cb.onAdded?.(rule);
    return rule;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    this.persistence.remove(id);
    this.cb.onRemoved?.(id);
    return true;
  }

  /** Does any rule cover this (toolName, derived-target)? */
  match(toolName: string, target: string | null): ApprovalRule | null {
    for (const r of this.rules) {
      if (r.toolName !== toolName) continue;
      if (r.target === null) return r;
      if (target !== null && r.target === target) return r;
    }
    return null;
  }
}

/**
 * ApprovalPolicy adapter — returns "approve" when an existing rule matches
 * the (toolName, target) pair derived from the request, otherwise defers
 * to later policies in the cascade by returning "escalate".
 */
export function allowListPolicy(store: ApprovalRuleStore): ApprovalPolicy {
  return {
    async decide(ctx) {
      const target = targetFromInput(ctx.input);
      const hit = store.match(ctx.toolName, target);
      return hit ? "approve" : "escalate";
    },
  };
}
