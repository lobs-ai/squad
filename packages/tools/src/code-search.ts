/**
 * Code search tool — smart code search using ripgrep with context.
 *
 * Wraps ripgrep with useful defaults for code navigation: surrounding context
 * lines, language filtering, smart case, word matching, and result capping.
 */

import { spawn } from "node:child_process";
import type { ToolDefinition } from "./types.js";
import { capOutput } from "./output-cap.js";
import { BaseTool, type ToolContext } from "./base-tool.js";
import { resolveToCwd } from "./path-utils.js";

// ── Tool Definition ──────────────────────────────────────────────────────────

export const codeSearchToolDefinition: ToolDefinition = {
  name: "code_search",
  description:
    "Search code with context. Returns matches with surrounding lines for better understanding. " +
    "Useful for finding function definitions, usages, imports, and code patterns.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regex pattern to search for",
      },
      path: {
        type: "string",
        description: "File or directory to search (default: current directory)",
      },
      language: {
        type: "string",
        description:
          "Filter by language/file type (e.g. 'ts', 'python', 'rust', 'go'). Maps to ripgrep's --type flag.",
      },
      context_lines: {
        type: "number",
        description: "Number of context lines around each match (default: 3)",
      },
      max_results: {
        type: "number",
        description: "Maximum number of matches to return (default: 50)",
      },
      word_match: {
        type: "boolean",
        description: "Match whole words only (default: false)",
      },
      case_sensitive: {
        type: "boolean",
        description:
          "Case sensitive search (default: smart case — case sensitive if pattern has uppercase)",
      },
    },
    required: ["pattern"],
  },
};

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_CAPTURE = 200_000;
const TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_RESULTS = 50;

// ── Helpers ──────────────────────────────────────────────────────────────────

function commandExists(cmd: string): Promise<boolean> {
  return new Promise((res) => {
    const child = spawn("which", [cmd], { stdio: "ignore" });
    child.on("close", (code) => res(code === 0));
    child.on("error", () => res(false));
  });
}

// Language aliases → rg --type names
const LANGUAGE_MAP: Record<string, string> = {
  ts: "ts",
  typescript: "ts",
  js: "js",
  javascript: "js",
  tsx: "tsx",
  jsx: "jsx",
  py: "py",
  python: "py",
  rs: "rust",
  rust: "rust",
  go: "go",
  java: "java",
  rb: "ruby",
  ruby: "ruby",
  sh: "sh",
  bash: "sh",
  md: "markdown",
  markdown: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  html: "html",
};

// ── Tool Implementation ──────────────────────────────────────────────────────

export async function codeSearchTool(
  params: Record<string, unknown>,
  cwd: string,
): Promise<string> {
  const pattern = params.pattern as string;
  if (!pattern) throw new Error("pattern is required");

  const searchPath = (params.path as string) || ".";
  const resolved = resolveToCwd(searchPath, cwd);
  const language = params.language as string | undefined;
  const contextLines = (params.context_lines as number | undefined) ?? DEFAULT_CONTEXT;
  const maxResults = (params.max_results as number | undefined) ?? DEFAULT_MAX_RESULTS;
  const wordMatch = params.word_match as boolean | undefined;
  const caseSensitive = params.case_sensitive as boolean | undefined;

  const hasRg = await commandExists("rg");
  if (!hasRg) {
    return "ripgrep (rg) is required for code_search. Install it with: brew install ripgrep";
  }

  const args = [
    "--color=never",
    "--line-number",
    "--heading",
    "-C", String(contextLines),
    "--max-count", String(maxResults),
  ];

  if (caseSensitive === true) args.push("--case-sensitive");
  else if (caseSensitive === false) args.push("--ignore-case");
  else args.push("--smart-case");

  if (wordMatch) args.push("--word-regexp");

  if (language) {
    const rgType = LANGUAGE_MAP[language.toLowerCase()];
    if (rgType) args.push("--type", rgType);
  }

  // Exclude .git
  args.push("--glob=!.git");

  args.push(pattern, resolved);

  return new Promise<string>((resolvePromise) => {
    let output = "";
    let stderr = "";

    const child = spawn("rg", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
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
      resolvePromise(`Error running rg: ${err.message}`);
    });

    child.on("close", (code) => {
      clearTimeout(timer);

      if (code === 1 && !output) {
        resolvePromise("No matches found.");
        return;
      }
      if (stderr && !output) {
        resolvePromise(`Error: ${stderr.trim()}`);
        return;
      }

      const result = output.trim();
      if (!result) {
        resolvePromise("No matches found.");
        return;
      }

      resolvePromise(capOutput(result));
    });
  });
}

// ── Class-based API ───────────────────────────────────────────────────────────

export class CodeSearchTool extends BaseTool {
  readonly name = "code-search";
  readonly tags = ["filesystem", "readonly", "search"] as const;
  readonly description = codeSearchToolDefinition.description;
  readonly inputSchema = codeSearchToolDefinition.input_schema as import("./base-tool.js").ToolInputSchema;

  run(params: Record<string, unknown>, ctx: ToolContext) {
    return codeSearchTool(params, ctx.cwd);
  }
}
