import { randomUUID } from "node:crypto";
import type { ApprovalPolicy } from "@squad/plugin-sdk";
import type {
  ApprovalPredicate,
  ApprovalRule,
  ApprovalScope,
} from "@squad/protocol";
import type { ApprovalRulePersistence } from "./rules-persist.js";
import {
  evaluateApprovalPredicate,
  type PredicateContext,
} from "./predicate.js";

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
  /** Optional predicate — when present, target is ignored. */
  predicate?: ApprovalPredicate;
  /** "approve" | "deny" — defaults to "approve". */
  decision?: "approve" | "deny";
  scope?: ApprovalScope;
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
  for (const key of ["path", "file_path", "filePath", "target", "cmd", "command", "url", "query"]) {
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
    // Collapse exact duplicates of *literal* (toolName, target) rules. Predicate
    // rules are never collapsed since two predicates that look "the same"
    // structurally may still differ in scope or decision.
    if (!input.predicate) {
      const existing = this.rules.find(
        (r) =>
          !r.predicate &&
          r.toolName === input.toolName &&
          r.target === input.target &&
          (r.decision ?? "approve") === (input.decision ?? "approve") &&
          scopeEq(r.scope, input.scope),
      );
      if (existing) return existing;
    }
    const rule: ApprovalRule = {
      id: "ar_" + randomUUID().slice(0, 8),
      toolName: input.toolName,
      target: input.target,
      label: input.label ?? null,
      createdAt: new Date().toISOString(),
      createdBy: input.createdBy ?? null,
      ...(input.predicate ? { predicate: input.predicate } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.scope ? { scope: input.scope } : {}),
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

  /**
   * Find the first rule that matches the (toolName, target) pair. Used by
   * the legacy allow-list policy path. Predicate rules are skipped here —
   * they're matched via `matchPredicate` against the full PredicateContext.
   */
  match(toolName: string, target: string | null): ApprovalRule | null {
    for (const r of this.rules) {
      if (r.predicate) continue;
      if (r.toolName !== toolName) continue;
      if (r.target === null) return r;
      if (target !== null && r.target === target) return r;
    }
    return null;
  }

  /**
   * Walk every rule; return the first rule whose scope + match logic
   * succeeds against the predicate context. Predicate rules win over
   * literal-target rules when both match (they're checked in store order,
   * which is insertion order — the user's most recent rule edits take
   * precedence by being inserted later in this scan).
   */
  matchInContext(ctx: PredicateContext): ApprovalRule | null {
    for (const r of this.rules) {
      if (!scopeMatches(r.scope, ctx)) continue;
      if (r.toolName !== ctx.toolName) continue;
      if (r.predicate) {
        if (evaluateApprovalPredicate(r.predicate, ctx)) return r;
        continue;
      }
      const target = targetFromInput(ctx.input);
      if (r.target === null) return r;
      if (target !== null && r.target === target) return r;
    }
    return null;
  }
}

function scopeEq(a: ApprovalScope | undefined, b: ApprovalScope | undefined): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.kind === "session" && b.kind === "session") return a.sessionId === b.sessionId;
  if (a.kind === "subagent" && b.kind === "subagent") return a.subagent === b.subagent;
  return true; // both global
}

function scopeMatches(scope: ApprovalScope | undefined, ctx: PredicateContext): boolean {
  if (!scope || scope.kind === "global") return true;
  if (scope.kind === "session") return ctx.sessionId === scope.sessionId;
  if (scope.kind === "subagent") return ctx.subagent === scope.subagent;
  return false;
}

/**
 * ApprovalPolicy adapter — checks every rule (literal + predicate) against
 * the call. A matched approve-rule short-circuits to "approve"; a matched
 * deny-rule short-circuits to "deny"; no match returns "escalate" so later
 * policies in the cascade get a turn.
 *
 * The adapter takes the ctx from the runner's hook so it can populate
 * `subagent` and `parentSessionId` for predicate evaluation. We don't have
 * a direct way to learn the subagent kind from inside the hook, so callers
 * that want subagent-scoped rules must pass a resolver.
 */
export function allowListPolicy(
  store: ApprovalRuleStore,
  resolveSubagent?: (sessionId: string | null) => string | null,
): ApprovalPolicy {
  return {
    async decide(ctx) {
      const predCtx: PredicateContext = {
        toolName: ctx.toolName,
        input: ctx.input,
        tags: ctx.tags,
        sessionId: ctx.sessionId,
        parentSessionId: ctx.parentSessionId,
        subagent: resolveSubagent ? resolveSubagent(ctx.sessionId) : null,
      };
      const hit = store.matchInContext(predCtx);
      if (!hit) return "escalate";
      return hit.decision ?? "approve";
    },
  };
}
