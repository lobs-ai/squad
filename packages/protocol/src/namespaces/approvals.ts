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

export const approvalMethods = {
  "approvals.list": { params: approvalsListParams, result: approvalsListResult },
  "approvals.decide": { params: approvalsDecideParams, result: approvalsDecideResult },
} as const;

export const approvalPendingEvent = z.object({ approval: approvalRecordSchema });
export const approvalDecidedEvent = z.object({ approval: approvalRecordSchema });

export const approvalEvents = {
  "approvals.pending": approvalPendingEvent,
  "approvals.decided": approvalDecidedEvent,
} as const;
