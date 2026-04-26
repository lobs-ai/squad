import type { Dispatcher } from "./index.js";
import type { ApprovalStore } from "../approvals/store.js";

export function registerApprovalMethods(dispatcher: Dispatcher, approvals: ApprovalStore): void {
  dispatcher.register("approvals.list", async (params) => ({
    approvals: approvals.list({
      ...(params?.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params?.status !== undefined ? { status: params.status } : {}),
    }),
  }));

  dispatcher.register("approvals.decide", async (params, ctx) => {
    const updated = approvals.decide({
      approvalId: params.approvalId,
      decision: params.decision,
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(ctx.grant.label !== undefined ? { decidedBy: ctx.grant.label } : {}),
    });
    if (!updated) {
      throw new Error(`unknown approval: ${params.approvalId}`);
    }
    return { approval: updated };
  });
}
