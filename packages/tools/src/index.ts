export * from "./types.js";
export * from "./base-tool.js";
export * from "./registry.js";
export * from "./tasks/index.js";
export * from "./questions/index.js";
export * from "./subagents/index.js";
export * from "./config/index.js";

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
  PRESETS,
  PRESET_NAMES,
  themeCss,
  injectStyle,
} from "./html-to-pdf.js";
export type { HtmlDiagnostics, HtmlOverflowItem, HtmlBrokenImage, ThemeName } from "./html-to-pdf.js";

// ── Default tool set ──────────────────────────────────────────────────────────
//
// Everything below powers `BUILTIN_TOOLS` — the set that should be available to
// the main agent and any subagent that doesn't deliberately opt out. The main
// agent gets full access by design; subagents filter this list via their
// `SubagentDefinition.tools` array.

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
} from "./pptx.js";
import { HtmlToPdfTool, HtmlCheckTool, HtmlStyleGuideTool } from "./html-to-pdf.js";
import type { BaseTool } from "./base-tool.js";

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
