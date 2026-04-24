/**
 * Glob tool — find files by glob pattern.
 *
 * Uses fd if available, falls back to the find command.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "./types.js";
import { capOutput } from "./output-cap.js";
import { resolveToCwd } from "./path-utils.js";
import { BaseTool, type ToolContext } from "./base-tool.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const globToolDefinition: ToolDefinition = {
  name: "glob",
  description:
    "Fast file pattern matching across the codebase. Use this to find files by name or path patterns " +
    "such as '**/*.ts' or 'src/**/*.tsx' before reading or editing them. " +
    "Prefer this over shelling out to find or fd through Bash.",
  input_schema: {
    type: "object",
    properties: {
      glob: {
        type: "string",
        description: "Glob pattern to match",
      },
      pattern: {
        type: "string",
        description: "Backward-compatible glob pattern field; glob is preferred",
      },
      path: {
        type: "string",
        description: "Base directory for search (default: current directory)",
      },
    },
    required: [],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 200_000;
const TIMEOUT_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => res(code === 0));
    child.on("error", () => res(false));
  });
}

function relativizePaths(output: string, cwd: string): string {
  const prefix = cwd.endsWith("/") ? cwd : cwd + "/";
  return output
    .split("\n")
    .map((line) => (line.startsWith(prefix) ? line.slice(prefix.length) : line))
    .join("\n");
}

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function globTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = (params.glob as string) ?? (params.pattern as string);
  if (!pattern) throw new Error("glob pattern is required");

  const basePath = (params.path as string) || ".";
  const resolved = resolveToCwd(basePath, cwd);

  const hasFd = await commandExists("fd");

  let cmd: string;
  let args: string[];

  if (hasFd) {
    // fd recurses by default — strip leading path prefix and **/ from pattern
    let searchDir = resolved;
    let fdPattern = pattern;

    const match = pattern.match(/^([^*?{[]+\/)/);
    if (match) {
      const prefix = match[1].replace(/\/$/, "");
      searchDir = resolveToCwd(prefix, resolved);
      fdPattern = pattern.slice(match[1].length);
    }

    fdPattern = fdPattern.replace(/\*\*\//g, "");
    if (!fdPattern) fdPattern = "*";

    cmd = "fd";
    args = ["--glob", "--color=never", fdPattern, searchDir];
  } else {
    cmd = "find";
    if (pattern.includes("/")) {
      args = [resolved, "-path", `*${pattern}`, "-print"];
    } else {
      args = [resolved, "-name", pattern, "-print"];
    }
  }

  return new Promise<string>((resolvePromise) => {
    let output = "";
    let stderr = "";

    const child = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000);
    }, TIMEOUT_MS);

    child.stdout.on("data", (d: Buffer) => {
      if (output.length < MAX_CAPTURE) output += d.toString().slice(0, MAX_CAPTURE - output.length);
    });
    child.stderr.on("data", (d: Buffer) => {
      if (stderr.length < MAX_CAPTURE) stderr += d.toString().slice(0, MAX_CAPTURE - stderr.length);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolvePromise(`Error running ${cmd}: ${err.message}`);
    });

    child.on("close", () => {
      clearTimeout(timer);

      if (stderr && !output) {
        resolvePromise(`Error: ${stderr.trim()}`);
        return;
      }

      const result = output.trim();
      if (!result) {
        resolvePromise("No files matched the pattern.");
        return;
      }

      const relativized = relativizePaths(result, cwd);
      const matchCount = relativized.split("\n").filter(Boolean).length;
      const header = `Found ${matchCount} file${matchCount === 1 ? "" : "s"}:\n`;

      resolvePromise(header + capOutput(relativized));
    });
  });
}

// ── Class-based API ───────────────────────────────────────────────────────────

export class GlobTool extends BaseTool {
  readonly name = "glob";
  readonly tags = ["filesystem", "readonly", "search"] as const;
  readonly description = globToolDefinition.description;
  readonly inputSchema = globToolDefinition.input_schema as import("./base-tool.js").ToolInputSchema;

  run(params: Record<string, unknown>, ctx: ToolContext) {
    return globTool(params, ctx.cwd);
  }
}
