import type { Dispatcher } from "./index.js";
import type { ApprovalStore } from "../approvals/store.js";
import type { ApprovalRuleStore } from "../approvals/rules.js";
import { targetFromInput } from "../approvals/rules.js";

export interface ApprovalDispatchDeps {
  approvals: ApprovalStore;
  /** Optional — when absent, rule-management methods are not registered. */
  rules?: ApprovalRuleStore;
}

export function registerApprovalMethods(
  dispatcher: Dispatcher,
  deps: ApprovalDispatchDeps,
): void {
  const { approvals, rules } = deps;

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

  if (!rules) return;

  dispatcher.register("approvals.list_rules", async () => ({
    rules: rules.list(),
  }));

  dispatcher.register("approvals.allow_path", async (params, ctx) => {
    const pending = approvals.get(params.approvalId);
    if (!pending) {
      throw new Error(`unknown approval: ${params.approvalId}`);
    }
    const scope = params.scope ?? "exact";
    const target = scope === "tool" ? null : targetFromInput(pending.input);
    const rule = rules.add({
      toolName: pending.toolName,
      target,
      label: target ?? pending.toolName,
      ...(ctx.grant.label !== undefined ? { createdBy: ctx.grant.label } : {}),
    });
    // If the request is still pending, decide it now so the agent unblocks.
    // If it already settled (race with another client), just return the
    // rule + the existing record.
    const decided =
      pending.status === "pending"
        ? approvals.decide({
            approvalId: pending.id,
            decision: "approve",
            reason: `always allow rule ${rule.id}`,
            ...(ctx.grant.label !== undefined ? { decidedBy: ctx.grant.label } : {}),
          })
        : pending;
    return { approval: decided ?? pending, rule };
  });

  dispatcher.register("approvals.remove_rule", async (params) => ({
    ok: rules.remove(params.ruleId),
  }));
}
