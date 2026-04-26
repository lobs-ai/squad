import { randomUUID } from "node:crypto";
import type { ApprovalRecord, ApprovalDecision } from "@squad/protocol";

export interface ApprovalStoreCallbacks {
  onPending?: (a: ApprovalRecord) => void;
  onDecided?: (a: ApprovalRecord) => void;
}

export interface RaiseInput {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: unknown;
  tags: string[];
}

export interface DecideInput {
  approvalId: string;
  decision: ApprovalDecision;
  reason?: string;
  decidedBy?: string;
}

interface PendingResolver {
  resolve: (a: ApprovalRecord) => void;
}

/**
 * In-memory pending-approval registry. The gateway (and future tool runner)
 * raise(...) when a tool call needs human consent and await on the returned
 * promise; the dashboard or CLI calls decide(...) which resolves any waiter
 * and publishes the standard `approvals.*` events.
 *
 * Persistence is intentionally skipped for v1 — pending approvals are
 * single-process state. A restart drops them; the agent can re-ask if
 * needed. When approvals.* needs to survive restarts we'll back this with
 * a SQLite table.
 */
export class ApprovalStore {
  private readonly approvals: Map<string, ApprovalRecord> = new Map();
  private readonly waiters: Map<string, PendingResolver> = new Map();

  constructor(private readonly cb: ApprovalStoreCallbacks = {}) {}

  list(opts: { sessionId?: string; status?: ApprovalRecord["status"][] } = {}): ApprovalRecord[] {
    const out: ApprovalRecord[] = [];
    for (const a of this.approvals.values()) {
      if (opts.sessionId && a.sessionId !== opts.sessionId) continue;
      if (opts.status && opts.status.length > 0 && !opts.status.includes(a.status)) continue;
      out.push(a);
    }
    // Newest pending first, then older history.
    out.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    return out;
  }

  get(id: string): ApprovalRecord | null {
    return this.approvals.get(id) ?? null;
  }

  /**
   * Record a pending approval and return both the ApprovalRecord and a
   * Promise that resolves when a decide() call lands. Callers can `await`
   * the promise to block their tool execution.
   */
  raise(input: RaiseInput): { approval: ApprovalRecord; settled: Promise<ApprovalRecord> } {
    const id = "ap_" + randomUUID().slice(0, 8);
    const approval: ApprovalRecord = {
      id,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.input,
      tags: [...input.tags],
      status: "pending",
      decision: null,
      reason: null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.approvals.set(id, approval);
    this.cb.onPending?.(approval);
    const settled = new Promise<ApprovalRecord>((resolve) => {
      this.waiters.set(id, { resolve });
    });
    return { approval, settled };
  }

  decide(input: DecideInput): ApprovalRecord | null {
    const cur = this.approvals.get(input.approvalId);
    if (!cur || cur.status !== "pending") return cur ?? null;
    const updated: ApprovalRecord = {
      ...cur,
      status: input.decision === "approve" ? "approved" : "denied",
      decision: input.decision,
      reason: input.reason ?? null,
      decidedBy: input.decidedBy ?? null,
      decidedAt: new Date().toISOString(),
    };
    this.approvals.set(updated.id, updated);
    this.cb.onDecided?.(updated);
    const waiter = this.waiters.get(updated.id);
    if (waiter) {
      waiter.resolve(updated);
      this.waiters.delete(updated.id);
    }
    return updated;
  }
}
