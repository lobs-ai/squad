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
export const approvalRuleSchema = z.object({
  id: z.string(),
  toolName: z.string(),
  target: z.string().nullable(),
  label: z.string().nullable(),
  createdAt: z.string(),
  createdBy: z.string().nullable(),
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
