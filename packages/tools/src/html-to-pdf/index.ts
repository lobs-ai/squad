/**
 * html_to_pdf / html_check / html_style_guide — extendable HTML→PDF for agents.
 *
 * Presets and themes are extendable: call `registerPreset` / `registerTheme`
 * before constructing the tools to add or override entries.
 */

import type { ToolGroup } from "../groups.js";
import {
  HtmlToPdfTool,
  HtmlCheckTool,
  HtmlStyleGuideTool,
} from "./tools.js";

export {
  HtmlToPdfTool,
  HtmlCheckTool,
  HtmlStyleGuideTool,
  htmlToPdfTool,
  htmlCheckTool,
  htmlStyleGuideTool,
  parseLengthToPx,
  parseMargins,
  parsePaper,
  gatherDiagnostics,
} from "./tools.js";
export type {
  HtmlDiagnostics,
  HtmlOverflowItem,
  HtmlBrokenImage,
} from "./tools.js";

export {
  registerPreset,
  getPreset,
  listPresetNames,
  marginsFromIn,
  paperFromFormat,
  paperCustom,
  marginsToPdfOpt,
  PX_PER_INCH,
  FORMAT_INCHES,
} from "./presets.js";
export type {
  Preset,
  PresetFactory,
  Paper,
  Margins,
  PdfFormat,
} from "./presets.js";

export {
  registerTheme,
  getTheme,
  listThemeNames,
  themeCss,
  injectStyle,
  DESIGN_LINT_PROBES,
} from "./themes.js";
export type {
  ThemeContext,
  ThemeFactory,
  ThemeName,
} from "./themes.js";

/** All html-to-pdf tool instances. */
export const HTML_TO_PDF_TOOLS = [
  new HtmlToPdfTool(),
  new HtmlCheckTool(),
  new HtmlStyleGuideTool(),
] as const;

/** Tool group for lazy-loading via describe_tool_group. */
export const htmlToPdfGroup: ToolGroup = {
  name: "html-to-pdf",
  description: "Render HTML to a PDF (or PNG preview) with built-in themes and presets",
  toolNames: ["html_to_pdf", "html_check", "html_style_guide"],
  guidance: [
    "html_to_pdf renders HTML to a polished PDF. Pass one of `html` / `path` / `url`",
    "plus `output_path`. The default `preset: \"document\"` gives Letter paper, 0.75in",
    "margins, and clean typography — most jobs only need to override `preset`.",
    "",
    "Common presets: document, report, letter, letter-landscape, a4, a4-landscape,",
    "legal, deck/slides-16x9, slides-4x3, minimal, none.",
    "",
    "Iterate visually with `html_check` first — same params, writes only a PNG so",
    "you can fix layout cheaply before committing to a PDF.",
    "",
    "`html_style_guide` prints the cookbook plus theme CSS so you can read what",
    "each preset injects.",
    "",
    "Pitfalls: don't write inline @page CSS unless you know why; use pt/px (not in)",
    "for font-size; vh/vw are unreliable in print; use absolute https:// or data:",
    "URIs for images.",
  ].join("\n"),
};
