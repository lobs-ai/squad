export * from "./types.js";
export * from "./base-tool.js";
export * from "./registry.js";
export * from "./groups.js";
export * from "./tasks/index.js";
export * from "./questions/index.js";
export * from "./subagents/index.js";
export * from "./config/index.js";
export * from "./memory/index.js";
export * from "./cron/index.js";

// ── Utilities ────────────────────────────────────────────────────────────────
export { capOutput, DEFAULT_OUTPUT_CAP, DEFAULT_MAX_LINES } from "./output-cap.js";
export { resolveToCwd } from "./path-utils.js";

// ── Read snapshot helpers ─────────────────────────────────────────────────────
export {
  createReadSnapshot,
  hasRecentlyReadFile,
  updateReadSnapshot,
  getReadSnapshot,
  clearRecentReadTracking,
} from "./read.js";
export type { ReadSnapshot } from "./read.js";

// ── Filesystem / exec tools ───────────────────────────────────────────────────
export { ReadTool, readToolDefinition, readTool } from "./read.js";
export { WriteTool, writeToolDefinition, writeTool } from "./write.js";
export { EditTool, editToolDefinition, editTool } from "./edit.js";
export { ExecTool, execToolDefinition, execTool } from "./exec.js";
export type { ExecToolOptions } from "./exec.js";
export { LsTool, lsToolDefinition, lsTool } from "./ls.js";
export { GrepTool, grepToolDefinition, grepTool } from "./grep.js";
export { GlobTool, globToolDefinition, globTool } from "./glob.js";
export { FindFilesTool, findFilesToolDefinition, findFilesTool } from "./find-files.js";
export { CodeSearchTool, codeSearchToolDefinition, codeSearchTool } from "./code-search.js";

// ── Web tools ─────────────────────────────────────────────────────────────────
export { WebSearchTool, webSearchToolDefinition, webSearchTool } from "./web-search.js";
export type { WebSearchToolOptions } from "./web-search.js";
export { WebFetchTool, webFetchToolDefinition, webFetchTool } from "./web-fetch.js";
export type { WebFetchToolOptions } from "./web-fetch.js";
export { BrowserService, browserService, setupSearXNG } from "./browser-service.js";
export type { BrowserServiceOptions, SearchResult, FetchResult } from "./browser-service.js";

// ── PowerPoint tools ──────────────────────────────────────────────────────────
export {
  PptxCreateTool,
  PptxAddSlideTool,
  PptxAddTextTool,
  PptxAddImageTool,
  PptxAddShapeTool,
  PptxAddTableTool,
  PptxAddChartTool,
  PptxSaveTool,
  PPTX_TOOLS,
  pptxGroup,
} from "./pptx.js";

// ── HTML → PDF ────────────────────────────────────────────────────────────────
export {
  HtmlToPdfTool,
  htmlToPdfTool,
  HtmlCheckTool,
  htmlCheckTool,
  HtmlStyleGuideTool,
  htmlStyleGuideTool,
  parseLengthToPx,
  parseMargins,
  parsePaper,
  gatherDiagnostics,
  registerPreset,
  getPreset,
  listPresetNames,
  registerTheme,
  getTheme,
  listThemeNames,
  themeCss,
  injectStyle,
  HTML_TO_PDF_TOOLS,
  htmlToPdfGroup,
} from "./html-to-pdf/index.js";
export type {
  HtmlDiagnostics,
  HtmlOverflowItem,
  HtmlBrokenImage,
  ThemeName,
  ThemeContext,
  ThemeFactory,
  Preset,
  PresetFactory,
  Paper,
  Margins,
  PdfFormat,
} from "./html-to-pdf/index.js";

// ── Default tool set ──────────────────────────────────────────────────────────
//
// `BUILTIN_TOOLS` is the set of tools registered into the ToolRegistry on
// every gateway boot, regardless of which groups end up in the prompt. The
// runner uses the tool registry only to *execute* tools the LLM picks; the
// per-turn allow-list (computed from default groups + unlocked groups in
// runs.ts) is what determines which schemas the LLM actually sees.
//
// Subagents filter this list via their `SubagentDefinition.tools` array.

import { ReadTool } from "./read.js";
import { WriteTool } from "./write.js";
import { EditTool } from "./edit.js";
import { ExecTool } from "./exec.js";
import { LsTool } from "./ls.js";
import { GrepTool } from "./grep.js";
import { GlobTool } from "./glob.js";
import { FindFilesTool } from "./find-files.js";
import { CodeSearchTool } from "./code-search.js";
import { WebSearchTool } from "./web-search.js";
import { WebFetchTool } from "./web-fetch.js";
import {
  PptxCreateTool,
  PptxAddSlideTool,
  PptxAddTextTool,
  PptxAddImageTool,
  PptxAddShapeTool,
  PptxAddTableTool,
  PptxAddChartTool,
  PptxSaveTool,
  pptxGroup,
} from "./pptx.js";
import { HtmlToPdfTool, HtmlCheckTool, HtmlStyleGuideTool, htmlToPdfGroup } from "./html-to-pdf/index.js";
import type { BaseTool } from "./base-tool.js";
import type { ToolGroup } from "./groups.js";
import { cronGroup } from "./cron/index.js";
import { tasksGroup } from "./tasks/index.js";
import { memoryGroup } from "./memory/index.js";
import { configGroup } from "./config/index.js";
import { questionsGroup } from "./questions/index.js";
import { subagentsGroup } from "./subagents/index.js";

/** All built-in tool class instances. */
export const BUILTIN_TOOLS: readonly BaseTool[] = [
  new ReadTool(),
  new WriteTool(),
  new EditTool(),
  new ExecTool(),
  new LsTool(),
  new GrepTool(),
  new GlobTool(),
  new FindFilesTool(),
  new CodeSearchTool(),
  new WebSearchTool(),
  new WebFetchTool(),
  new PptxCreateTool(),
  new PptxAddSlideTool(),
  new PptxAddTextTool(),
  new PptxAddImageTool(),
  new PptxAddShapeTool(),
  new PptxAddTableTool(),
  new PptxAddChartTool(),
  new PptxSaveTool(),
  new HtmlToPdfTool(),
  new HtmlCheckTool(),
  new HtmlStyleGuideTool(),
] as const;

// ── Default groups — loaded on every turn ────────────────────────────────────

/** Filesystem read/write/edit + dir listing. Default. */
export const filesystemGroup: ToolGroup = {
  name: "filesystem",
  description: "Read, write, and edit files in the workspace",
  toolNames: ["read", "write", "edit", "ls"],
  guidance: "Use Read before Write or Edit. Edit accepts a unique old_string; Write overwrites.",
  default: true,
};

/** Fast code/file search across the workspace. Default. */
export const searchGroup: ToolGroup = {
  name: "search",
  description: "Search the workspace by content (grep), name (glob/find_files), or symbols (code_search)",
  toolNames: ["grep", "glob", "find_files", "code_search"],
  guidance: "Prefer grep for content; glob/find_files for paths; code_search for symbol-aware lookup.",
  default: true,
};

/** Shell exec. Default. */
export const execGroup: ToolGroup = {
  name: "exec",
  description: "Run shell commands (build, test, git, gh, …)",
  toolNames: ["exec"],
  guidance:
    "Prefer the dedicated tools (Read/Edit/Write) over shell equivalents (cat/sed/echo). " +
    "Use exec for builds, tests, git, gh, and anything truly shell-only. cd via newCwd is sticky.",
  default: true,
};

/** Web search / fetch. Default. */
export const webGroup: ToolGroup = {
  name: "web",
  description: "Search the web and fetch URL content",
  toolNames: ["web_search", "web_fetch"],
  guidance: "Use web_search to discover sources and web_fetch to read a single URL in detail.",
  default: true,
};

/**
 * Every built-in group, default + lazy. Order matters for the prompt index —
 * defaults first, lazy second. Callers that build a `ToolGroupRegistry` can
 * simply `registerAll(BUILTIN_GROUPS)`.
 */
export const BUILTIN_GROUPS: readonly ToolGroup[] = [
  filesystemGroup,
  searchGroup,
  execGroup,
  webGroup,
  questionsGroup,
  cronGroup,
  tasksGroup,
  subagentsGroup,
  memoryGroup,
  configGroup,
  htmlToPdfGroup,
  pptxGroup,
] as const;
