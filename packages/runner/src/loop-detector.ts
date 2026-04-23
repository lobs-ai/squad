// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/loop-detector.ts
// Last synced: 2026-04-23

/**
 * Loop detector — detects when an agent is making the same tool calls
 * repeatedly without making progress.
 *
 * Patterns detected:
 * 1. Generic repeat  — same tool + same input called N times
 * 2. Poll no-progress — same tool always returns identical output
 * 3. Ping-pong        — alternating A/B/A/B pattern
 */

interface ToolCallRecord {
  name: string;
  /** Hash of JSON.stringify(input) */
  inputHash: string;
  /** Hash of first 500 chars of output */
  outputHash: string;
  timestamp: number;
}

export interface LoopDetectionResult {
  detected: boolean;
  type: "generic-repeat" | "poll-no-progress" | "ping-pong" | null;
  message: string | null;
  severity: "warning" | "critical" | null;
}

export class LoopDetector {
  private history: ToolCallRecord[] = [];
  private readonly maxHistory = 30;
  private readonly warningThreshold = 8;
  private readonly criticalThreshold = 15;

  /** Record a tool call and check for loops. */
  record(
    name: string,
    input: Record<string, unknown>,
    output: string,
  ): LoopDetectionResult {
    const inputHash = simpleHash(JSON.stringify(input));
    const outputHash = simpleHash(output.substring(0, 500));

    this.history.push({ name, inputHash, outputHash, timestamp: Date.now() });
    if (this.history.length > this.maxHistory) {
      this.history.shift();
    }

    return this.detect();
  }

  reset(): void {
    this.history = [];
  }

  private detect(): LoopDetectionResult {
    const genericRepeat = this.detectGenericRepeat();
    if (genericRepeat) return genericRepeat;

    const pollNoProgress = this.detectPollNoProgress();
    if (pollNoProgress) return pollNoProgress;

    const pingPong = this.detectPingPong();
    if (pingPong) return pingPong;

    return { detected: false, type: null, message: null, severity: null };
  }

  private detectGenericRepeat(): LoopDetectionResult | null {
    if (this.history.length < this.warningThreshold) return null;

    const recent = this.history.slice(-this.warningThreshold);
    const first = recent[0];

    const allSame = recent.every(
      (r) => r.name === first.name && r.inputHash === first.inputHash,
    );
    if (!allSame) return null;

    const count = recent.length;
    const severity = count >= this.criticalThreshold ? "critical" : "warning";
    return {
      detected: true,
      type: "generic-repeat",
      message: `Called ${first.name} with identical input ${count} times`,
      severity,
    };
  }

  private detectPollNoProgress(): LoopDetectionResult | null {
    if (this.history.length < this.warningThreshold) return null;

    const recent = this.history.slice(-this.warningThreshold);
    const first = recent[0];

    const sameToolSameOutput = recent.every(
      (r) => r.name === first.name && r.outputHash === first.outputHash,
    );
    if (!sameToolSameOutput) return null;

    return {
      detected: true,
      type: "poll-no-progress",
      message: `Tool ${first.name} returning identical output ${recent.length} times — no progress`,
      severity: "warning",
    };
  }

  private detectPingPong(): LoopDetectionResult | null {
    if (this.history.length < 6) return null;

    const recent = this.history.slice(-6);
    const a = recent[0].name;
    const b = recent[1].name;

    if (a === b) return null;

    const isPingPong = recent.every((r, i) => r.name === (i % 2 === 0 ? a : b));
    if (!isPingPong) return null;

    return {
      detected: true,
      type: "ping-pong",
      message: `Alternating between ${a} and ${b} without progress`,
      severity: "warning",
    };
  }
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}
