import { describe, it, expect, vi } from "vitest";
import { ApprovalStore } from "./store.js";

describe("ApprovalStore", () => {
  it("raises a pending approval and notifies onPending", () => {
    const onPending = vi.fn();
    const store = new ApprovalStore({ onPending });
    const { approval } = store.raise({
      sessionId: "s1",
      toolCallId: "tc-1",
      toolName: "fs.write",
      input: { path: "x.txt" },
      tags: ["write"],
    });
    expect(approval.status).toBe("pending");
    expect(approval.toolName).toBe("fs.write");
    expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ id: approval.id }));
    expect(store.list()).toHaveLength(1);
    expect(store.list({ status: ["pending"] })).toHaveLength(1);
    expect(store.list({ status: ["approved"] })).toHaveLength(0);
  });

  it("decide() resolves the settled promise + transitions status", async () => {
    const onDecided = vi.fn();
    const store = new ApprovalStore({ onDecided });
    const { approval, settled } = store.raise({
      sessionId: "s1",
      toolCallId: "tc-1",
      toolName: "shell.exec",
      input: { cmd: "ls" },
      tags: ["exec"],
    });
    const resolved = settled.then((a) => a);
    const updated = store.decide({ approvalId: approval.id, decision: "approve", decidedBy: "rafe" });
    expect(updated?.status).toBe("approved");
    expect(updated?.decision).toBe("approve");
    expect(updated?.decidedBy).toBe("rafe");
    const a = await resolved;
    expect(a.status).toBe("approved");
    expect(onDecided).toHaveBeenCalledOnce();
  });

  it("decide() on unknown id returns null", () => {
    const store = new ApprovalStore();
    expect(store.decide({ approvalId: "nope", decision: "approve" })).toBeNull();
  });

  it("filters by sessionId", () => {
    const store = new ApprovalStore();
    store.raise({ sessionId: "a", toolCallId: "1", toolName: "t", input: {}, tags: [] });
    store.raise({ sessionId: "b", toolCallId: "2", toolName: "t", input: {}, tags: [] });
    expect(store.list({ sessionId: "a" })).toHaveLength(1);
    expect(store.list({ sessionId: "b" })).toHaveLength(1);
  });
});
