import { describe, it, expect } from "vitest";
import { evaluateApprovalPredicate, getField } from "./predicate.js";
import type { PredicateContext } from "./predicate.js";

const baseCtx: PredicateContext = {
  toolName: "exec",
  input: { cmd: "git push origin main" },
  tags: ["exec", "shell"],
  sessionId: "sess_1",
  parentSessionId: null,
  subagent: null,
};

describe("evaluateApprovalPredicate", () => {
  it("matches startsWith on dotted input", () => {
    expect(
      evaluateApprovalPredicate(
        { op: "startsWith", field: "input.cmd", value: "git " },
        baseCtx,
      ),
    ).toBe(true);
  });

  it("treats bare field path as input.X", () => {
    expect(
      evaluateApprovalPredicate({ op: "contains", field: "cmd", value: "push" }, baseCtx),
    ).toBe(true);
  });

  it("eq on toolName", () => {
    expect(
      evaluateApprovalPredicate({ op: "eq", field: "toolName", value: "exec" }, baseCtx),
    ).toBe(true);
    expect(
      evaluateApprovalPredicate({ op: "eq", field: "toolName", value: "write" }, baseCtx),
    ).toBe(false);
  });

  it("anyTag / allTags", () => {
    expect(evaluateApprovalPredicate({ op: "anyTag", values: ["readonly", "shell"] }, baseCtx))
      .toBe(true);
    expect(evaluateApprovalPredicate({ op: "allTags", values: ["exec", "shell"] }, baseCtx))
      .toBe(true);
    expect(evaluateApprovalPredicate({ op: "allTags", values: ["exec", "network"] }, baseCtx))
      .toBe(false);
  });

  it("and/or/not compose", () => {
    expect(
      evaluateApprovalPredicate(
        {
          op: "and",
          predicates: [
            { op: "eq", field: "toolName", value: "exec" },
            { op: "startsWith", field: "cmd", value: "git " },
          ],
        },
        baseCtx,
      ),
    ).toBe(true);

    expect(
      evaluateApprovalPredicate(
        {
          op: "not",
          predicate: { op: "eq", field: "toolName", value: "exec" },
        },
        baseCtx,
      ),
    ).toBe(false);

    expect(
      evaluateApprovalPredicate(
        {
          op: "or",
          predicates: [
            { op: "eq", field: "toolName", value: "write" },
            { op: "eq", field: "toolName", value: "exec" },
          ],
        },
        baseCtx,
      ),
    ).toBe(true);
  });

  it("regex on string fields", () => {
    expect(
      evaluateApprovalPredicate(
        { op: "regex", field: "cmd", value: "^git\\s+(push|pull)" },
        baseCtx,
      ),
    ).toBe(true);
  });

  it("returns false on missing fields rather than throwing", () => {
    expect(
      evaluateApprovalPredicate({ op: "eq", field: "input.missing", value: "x" }, baseCtx),
    ).toBe(false);
    expect(
      evaluateApprovalPredicate({ op: "exists", field: "input.cmd" }, baseCtx),
    ).toBe(true);
    expect(
      evaluateApprovalPredicate({ op: "exists", field: "input.missing" }, baseCtx),
    ).toBe(false);
  });
});

describe("getField", () => {
  it("walks input path", () => {
    expect(getField("input.cmd", baseCtx)).toBe("git push origin main");
    expect(getField("cmd", baseCtx)).toBe("git push origin main");
    expect(getField("toolName", baseCtx)).toBe("exec");
    expect(getField("tags", baseCtx)).toEqual(["exec", "shell"]);
  });
});
