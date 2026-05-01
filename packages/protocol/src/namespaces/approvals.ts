import { z } from "zod";

export const approvalDecisionSchema = z.enum(["approve", "deny"]);
export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

export const approvalStatusSchema = z.enum(["pending", "approved", "denied", "timed_out"]);

export const approvalRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  toolCallId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  tags: z.array(z.string()),
  status: approvalStatusSchema,
  decision: approvalDecisionSchema.nullable(),
  reason: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;

// approvals.list
export const approvalsListParams = z.object({
  sessionId: z.string().optional(),
  status: z.array(approvalStatusSchema).optional(),
});
export const approvalsListResult = z.object({ approvals: z.array(approvalRecordSchema) });

// approvals.decide
export const approvalsDecideParams = z.object({
  approvalId: z.string(),
  decision: approvalDecisionSchema,
  reason: z.string().optional(),
});
export const approvalsDecideResult = z.object({ approval: approvalRecordSchema });

// Persistent allow-list rules. `target: null` matches any target for the
// named tool (e.g. "always allow Bash"); otherwise the recorded string
// must equal the target derived from the tool input on a future call.
//
// `predicate` is the structured DSL: when present, evaluation switches from
// "exact-match (toolName, target)" to "evaluate predicate against the tool
// call". `decision` defaults to "approve". `scope` lets a rule bind to a
// single session or a single subagent kind.
export const approvalScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("session"), sessionId: z.string() }),
  z.object({ kind: z.literal("subagent"), subagent: z.string() }),
]);
export type ApprovalScope = z.infer<typeof approvalScopeSchema>;

const approvalPredicateBase = z.union([
  z.object({
    op: z.enum(["eq", "ne"]),
    field: z.string(),
    value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  }),
  z.object({
    op: z.enum(["startsWith", "endsWith", "contains", "regex"]),
    field: z.string(),
    value: z.string(),
  }),
  z.object({ op: z.enum(["in", "notIn"]), field: z.string(), values: z.array(z.string()) }),
  z.object({ op: z.literal("exists"), field: z.string() }),
  z.object({ op: z.literal("anyTag"), values: z.array(z.string()) }),
  z.object({ op: z.literal("allTags"), values: z.array(z.string()) }),
]);

export type ApprovalPredicate =
  | z.infer<typeof approvalPredicateBase>
  | { op: "and"; predicates: ApprovalPredicate[] }
  | { op: "or"; predicates: ApprovalPredicate[] }
  | { op: "not"; predicate: ApprovalPredicate };

export const approvalPredicateSchema: z.ZodType<ApprovalPredicate> = z.lazy(() =>
  z.union([
    approvalPredicateBase,
    z.object({ op: z.literal("and"), predicates: z.array(approvalPredicateSchema) }),
    z.object({ op: z.literal("or"), predicates: z.array(approvalPredicateSchema) }),
    z.object({ op: z.literal("not"), predicate: approvalPredicateSchema }),
  ]),
);

export const approvalRuleSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  target: z.string().nullable(),
  label: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
  /**
   * When set, the rule evaluates `predicate` instead of doing an exact
   * (toolName, target) match. `target` is ignored when predicate is set.
   */
  predicate: approvalPredicateSchema.optional(),
  /** "approve" | "deny" — defaults to "approve" for back-compat. */
  decision: z.enum(["approve", "deny"]).optional(),
  /** Where the rule applies. Defaults to global. */
  scope: approvalScopeSchema.optional(),
});
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

// approvals.list_rules
export const approvalsListRulesParams = z.object({});
export const approvalsListRulesResult = z.object({ rules: z.array(approvalRuleSchema) });

// approvals.allow_path — adds a rule derived from the named pending
// approval and auto-decides it as "approve" in one round-trip.
export const approvalsAllowPathParams = z.object({
  approvalId: z.string(),
  /**
   * "exact" stores the resolved target string; "tool" stores `null` so the
   * rule matches every target for this tool. Defaults to "exact".
   */
  scope: z.enum(["exact", "tool"]).optional(),
});
export const approvalsAllowPathResult = z.object({
  approval: approvalRecordSchema,
  rule: approvalRuleSchema,
});

// approvals.add_rule — create a rule directly (predicate or literal) without
// first having a pending approval to "always allow". Lets the dashboard /
// CLI ship a rule editor.
export const approvalsAddRuleParams = z.object({
  toolName: z.string(),
  target: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  predicate: approvalPredicateSchema.optional(),
  decision: z.enum(["approve", "deny"]).optional(),
  scope: approvalScopeSchema.optional(),
});
export const approvalsAddRuleResult = z.object({ rule: approvalRuleSchema });

// approvals.remove_rule
export const approvalsRemoveRuleParams = z.object({ ruleId: z.string() });
export const approvalsRemoveRuleResult = z.object({ ok: z.boolean() });

export const approvalMethods = {
  "approvals.list": { params: approvalsListParams, result: approvalsListResult },
  "approvals.decide": { params: approvalsDecideParams, result: approvalsDecideResult },
  "approvals.list_rules": {
    params: approvalsListRulesParams,
    result: approvalsListRulesResult,
  },
  "approvals.allow_path": {
    params: approvalsAllowPathParams,
    result: approvalsAllowPathResult,
  },
  "approvals.add_rule": {
    params: approvalsAddRuleParams,
    result: approvalsAddRuleResult,
  },
  "approvals.remove_rule": {
    params: approvalsRemoveRuleParams,
    result: approvalsRemoveRuleResult,
  },
} as const;

export const approvalPendingEvent = z.object({ approval: approvalRecordSchema });
export const approvalDecidedEvent = z.object({ approval: approvalRecordSchema });
export const approvalRuleAddedEvent = z.object({ rule: approvalRuleSchema });
export const approvalRuleRemovedEvent = z.object({ ruleId: z.string() });

export const approvalEvents = {
  "approvals.pending": approvalPendingEvent,
  "approvals.decided": approvalDecidedEvent,
  "approvals.rule_added": approvalRuleAddedEvent,
  "approvals.rule_removed": approvalRuleRemovedEvent,
} as const;
