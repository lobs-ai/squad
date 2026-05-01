import type { ApprovalPredicate } from "@squad/protocol";

/**
 * Context the predicate evaluates against. Mirrors the gateway's
 * before-tool-call hook input plus a couple of extras that policy authors
 * commonly want — session id, subagent name, parent session id.
 */
export interface PredicateContext {
  toolName: string;
  input: unknown;
  tags: string[];
  sessionId: string | null;
  parentSessionId: string | null;
  subagent: string | null;
}

/**
 * Evaluate a predicate. Returns false on any structural violation rather
 * than throwing, so a misconfigured rule degrades to "doesn't match"
 * instead of crashing the approval pipeline.
 */
export function evaluateApprovalPredicate(
  predicate: ApprovalPredicate,
  ctx: PredicateContext,
): boolean {
  try {
    return evalNode(predicate, ctx);
  } catch {
    return false;
  }
}

function evalNode(node: ApprovalPredicate, ctx: PredicateContext): boolean {
  switch (node.op) {
    case "and":
      return node.predicates.every((p) => evalNode(p, ctx));
    case "or":
      return node.predicates.some((p) => evalNode(p, ctx));
    case "not":
      return !evalNode(node.predicate, ctx);
    case "anyTag":
      return node.values.some((t) => ctx.tags.includes(t));
    case "allTags":
      return node.values.every((t) => ctx.tags.includes(t));
    case "exists":
      return getField(node.field, ctx) !== undefined;
    case "in":
      return matchValue(getField(node.field, ctx), (v) => node.values.includes(v));
    case "notIn":
      return matchValue(getField(node.field, ctx), (v) => !node.values.includes(v));
    case "eq":
      return primitiveEq(getField(node.field, ctx), node.value);
    case "ne":
      return !primitiveEq(getField(node.field, ctx), node.value);
    case "startsWith":
      return matchValue(getField(node.field, ctx), (v) => v.startsWith(node.value));
    case "endsWith":
      return matchValue(getField(node.field, ctx), (v) => v.endsWith(node.value));
    case "contains":
      return matchValue(getField(node.field, ctx), (v) => v.includes(node.value));
    case "regex": {
      const re = new RegExp(node.value);
      return matchValue(getField(node.field, ctx), (v) => re.test(v));
    }
  }
}

function matchValue(v: unknown, pred: (s: string) => boolean): boolean {
  if (typeof v === "string") return pred(v);
  if (Array.isArray(v)) return v.some((x) => typeof x === "string" && pred(x));
  return false;
}

function primitiveEq(a: unknown, b: string | number | boolean | null): boolean {
  if (b === null) return a === null || a === undefined;
  if (typeof a === typeof b) return a === b;
  // Loose string-vs-number coerce so JSON-loaded rules don't break on
  // {value: "123"} vs an input number.
  if (typeof b === "string" && (typeof a === "number" || typeof a === "boolean")) {
    return String(a) === b;
  }
  return false;
}

/**
 * Resolve a dotted field path against the predicate context. The first
 * segment selects the "root":
 *
 *   - `tool` / `toolName`         → ctx.toolName
 *   - `sessionId` / `parentSessionId` / `subagent` → ctx.X
 *   - `tags`                      → ctx.tags (array; matchValue handles)
 *   - `input.<path>`              → walk into ctx.input
 *
 * A bare path with no leading prefix walks ctx.input (so rules can stay
 * compact: `cmd` instead of `input.cmd`).
 */
export function getField(field: string, ctx: PredicateContext): unknown {
  const segments = field.split(".");
  if (segments.length === 0) return undefined;
  const head = segments[0]!;

  switch (head) {
    case "tool":
    case "toolName":
      return ctx.toolName;
    case "sessionId":
      return ctx.sessionId;
    case "parentSessionId":
      return ctx.parentSessionId;
    case "subagent":
      return ctx.subagent;
    case "tags":
      return ctx.tags;
    case "input":
      return walk(ctx.input, segments.slice(1));
  }
  return walk(ctx.input, segments);
}

function walk(root: unknown, path: string[]): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}
