// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/runner/src/session-transcript.ts
// Last synced: 2026-04-23

/**
 * Session transcript persistence.
 *
 * Saves conversation history to JSONL during agent runs, and generates
 * a human-readable Markdown summary on completion.
 *
 * File layout:
 * ```
 * ~/.lobs/agents/{agentType}/sessions/{runId}.jsonl   — machine-readable
 * ~/.lobs/agents/{agentType}/sessions/{runId}.md       — human-readable
 * ```
 *
 * Each JSONL line is a turn record. The final line is a summary entry
 * with `"type": "summary"`.
 */

import { mkdirSync, appendFileSync, writeFileSync, existsSync } from "node:fs";
import type { TokenUsage } from "./types.js";

// ── Turn Record ───────────────────────────────────────────────────────────────

export interface TurnRecord {
  turn: number;
  timestamp: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  usage: TokenUsage;
}

// ── Session Summary ───────────────────────────────────────────────────────────

export interface SessionSummary {
  type: "summary";
  runId: string;
  agentType: string;
  taskId?: string;
  succeeded: boolean;
  totalTurns: number;
  totalUsage: TokenUsage;
  durationSeconds: number;
  stopReason: string;
  error?: string;
  timestamp: string;
}

// ── SessionTranscript ─────────────────────────────────────────────────────────

export class SessionTranscript {
  private readonly sessionPath: string;
  private readonly markdownPath: string;
  private readonly startTime = Date.now();

  constructor(agentType: string, runId: string) {
    const homeDir = process.env["HOME"] ?? "";
    const sessionsDir = `${homeDir}/.lobs/agents/${agentType}/sessions`;
    mkdirSync(sessionsDir, { recursive: true });
    this.sessionPath = `${sessionsDir}/${runId}.jsonl`;
    this.markdownPath = `${sessionsDir}/${runId}.md`;
  }

  /** Append a turn record to the JSONL file. */
  writeTurn(record: TurnRecord): void {
    appendFileSync(this.sessionPath, JSON.stringify(record) + "\n");
  }

  /** Write the final summary entry and generate the Markdown file. */
  writeComplete(
    runId: string,
    agentType: string,
    succeeded: boolean,
    totalTurns: number,
    usage: TokenUsage,
    stopReason: string,
    error?: string,
  ): void {
    const summary: SessionSummary = {
      type: "summary",
      runId,
      agentType,
      succeeded,
      totalTurns,
      totalUsage: usage,
      durationSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      stopReason,
      error,
      timestamp: new Date().toISOString(),
    };

    appendFileSync(this.sessionPath, JSON.stringify(summary) + "\n");
    this.generateMarkdown(summary);
  }

  private generateMarkdown(summary: SessionSummary): void {
    if (existsSync(this.markdownPath)) return;

    const lines = [
      `# Agent Session: ${summary.runId}`,
      `**Agent**: ${summary.agentType}`,
      `**Date**: ${summary.timestamp}`,
      `**Status**: ${summary.succeeded ? "✅ Succeeded" : "❌ Failed"}`,
      `**Turns**: ${summary.totalTurns}`,
      `**Duration**: ${summary.durationSeconds}s`,
      `**Tokens**: ${summary.totalUsage.inputTokens} in / ${summary.totalUsage.outputTokens} out`,
      `**Stop reason**: ${summary.stopReason}`,
    ];

    if (summary.error) {
      lines.push(`**Error**: ${summary.error}`);
    }

    writeFileSync(this.markdownPath, lines.join("\n") + "\n");
  }
}
