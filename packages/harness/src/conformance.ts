/**
 * Harness conformance — the lockstep contract both adapters must satisfy.
 *
 * Drives one turn through a factory and validates the normalized event shape:
 * `session.init` first, a `turn.start` … `turn.end` bracket, `turn.end`
 * carries usage, and every `tool.end` pairs with a prior `tool.start`. Phase 2
 * runs the Claude and Codex factories through the same probe so they can't
 * silently diverge.
 */

import type {
  ApprovalHook,
  HarnessEvent,
  HarnessFactory,
  HarnessStartSpec,
  HarnessTurnInput,
} from "./types.js";

export interface ConformanceProbe {
  factory: HarnessFactory;
  /** A start spec the adapter can actually open in the test environment. */
  spec: HarnessStartSpec;
  approval?: ApprovalHook;
  input?: HarnessTurnInput;
}

export interface ConformanceReport {
  events: HarnessEvent[];
  harnessSessionId: string | undefined;
  ok: boolean;
  problems: string[];
}

const allowAll: ApprovalHook = async () => ({ behavior: "allow" });

/** Run one turn through a factory and validate the normalized contract. */
export async function runHarnessConformance(
  probe: ConformanceProbe,
): Promise<ConformanceReport> {
  const problems: string[] = [];
  const session = await probe.factory.open(probe.spec, probe.approval ?? allowAll);
  const events: HarnessEvent[] = [];
  try {
    for await (const ev of session.runTurn(probe.input ?? { text: "ping" })) {
      events.push(ev);
    }
  } finally {
    await session.close();
  }

  problems.push(...validateEventStream(events));

  if (probe.factory.kind !== session.kind) {
    problems.push(
      `session.kind ${session.kind} != factory.kind ${probe.factory.kind}`,
    );
  }

  return {
    events,
    harnessSessionId: session.harnessSessionId(),
    ok: problems.length === 0,
    problems,
  };
}

/** Validate a collected event stream against the contract. Exported so adapter
 * tests can assert on partial / canned streams too. */
export function validateEventStream(events: HarnessEvent[]): string[] {
  const problems: string[] = [];
  const types = events.map((e) => e.t);

  if (types[0] !== "session.init") {
    problems.push("first event must be session.init");
  }
  if (!types.includes("turn.start")) {
    problems.push("missing turn.start");
  }

  const endIdx = types.lastIndexOf("turn.end");
  if (endIdx === -1) {
    problems.push("missing terminal turn.end");
  } else {
    const end = events[endIdx];
    if (end.t === "turn.end" && !end.usage) {
      problems.push("turn.end missing usage");
    }
  }

  const open = new Set<string>();
  for (const ev of events) {
    if (ev.t === "tool.start") {
      open.add(ev.id);
    } else if (ev.t === "tool.end") {
      if (!open.has(ev.id)) {
        problems.push(`tool.end '${ev.id}' without a matching tool.start`);
      }
      open.delete(ev.id);
    }
  }

  return problems;
}
