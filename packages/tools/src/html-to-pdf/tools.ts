/**
 * html_to_pdf + html_check + html_style_guide — opinionated HTML-to-PDF for agents.
 *
 * Design goal: the easy path produces great output; the hard path is still
 * reachable. Most agents should need only `html` + `output_path` + maybe `preset`.
 *
 * One API, two output modes:
 *   html_to_pdf  — writes a PDF (and optionally a PNG preview), returns diagnostics.
 *   html_check   — same params, same diagnostics, but writes a PNG only.
 *                  Use it to iterate on layout before committing to PDF.
 *   html_style_guide — prints the built-in CSS / cookbook for reading.
 *
 * Presets and themes are extendable: call `registerPreset` / `registerTheme`
 * before constructing the tools to add or override entries.
 */

import { readFile, stat } from "node:fs/promises";
import type { Page } from "playwright";
import { browserService } from "../browser-service.js";
import { BaseTool, type ToolContext } from "../base-tool.js";
import { resolveToCwd } from "../path-utils.js";
import type { ToolExecutorResult } from "../types.js";
import {
  themeCss,
  injectStyle,
  DESIGN_LINT_PROBES,
} from "./themes.js";
import {
  PX_PER_INCH,
  type Margins,
  type Paper,
  parseLengthToPx,
  parseMargins,
  parsePaper,
  marginsToPdfOpt,
  paperFromFormat,
  getPreset,
  listPresetNames,
} from "./presets.js";

// ── Header/footer presets ────────────────────────────────────────────────────

type HeaderFooterPreset = "none" | "page-numbers" | "title" | "title-and-pages";

function resolveHeaderFooter(
  p: HeaderFooterPreset,
  customHeader: string | undefined,
  customFooter: string | undefined,
): { header: string | null; footer: string | null } {
  if (customHeader || customFooter) {
    return { header: customHeader ?? "<div></div>", footer: customFooter ?? "<div></div>" };
  }
  const empty = "<div></div>";
  const pageNum = `<div style="font-size:9pt;width:100%;text-align:center;color:#777;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;
  const titleTop = `<div style="font-size:9pt;width:100%;padding:0 0.5in;color:#777;"><span class="title"></span></div>`;
  switch (p) {
    case "none": return { header: null, footer: null };
    case "page-numbers": return { header: empty, footer: pageNum };
    case "title": return { header: titleTop, footer: null };
    case "title-and-pages": return { header: titleTop, footer: pageNum };
  }
}

// ── HTML source loading ──────────────────────────────────────────────────────

interface HtmlSource { content: string | null; url: string | null; description: string }

async function resolveHtmlSource(
  params: { html?: unknown; path?: unknown; url?: unknown },
  cwd: string,
  toolName: string,
): Promise<HtmlSource> {
  const html = params.html as string | undefined;
  const srcPath = params.path as string | undefined;
  const url = params.url as string | undefined;
  const count = [html, srcPath, url].filter((v) => v !== undefined).length;
  if (count === 0) throw new Error(`${toolName} requires one of: html, path, or url.`);
  if (count > 1) throw new Error(`${toolName} accepts only one of: html, path, or url.`);
  if (html !== undefined) return { content: html, url: null, description: "inline HTML" };
  if (srcPath !== undefined) {
    const resolved = resolveToCwd(srcPath, cwd);
    return { content: await readFile(resolved, "utf8"), url: null, description: `file ${resolved}` };
  }
  return { content: null, url: url!, description: `url ${url}` };
}

// ── Diagnostics ──────────────────────────────────────────────────────────────

export interface HtmlOverflowItem {
  tag: string; selector: string; text: string;
  overflowRightPx: number; overflowBottomPx: number;
}
export interface HtmlBrokenImage { src: string; width: number; height: number }

export interface HtmlDiagnostics {
  paper: { widthPx: number; heightPx: number; widthIn: number; heightIn: number; label: string };
  printable: { widthPx: number; heightPx: number };
  contentWidthPx: number;
  contentHeightPx: number;
  estimatedPages: number;
  horizontalOverflowPx: number;
  overflowingElements: HtmlOverflowItem[];
  brokenImages: HtmlBrokenImage[];
  imageCount: number;
  textLength: number;
  title: string | null;
  pageCssDetected: boolean;
  warnings: string[];
  advice: string[];
}

async function gatherDiagnostics(
  page: Page,
  paperWidthPx: number,
  paperHeightPx: number,
  printableWidthPx: number,
  printableHeightPx: number,
  paperLabel: string,
  designLint: boolean,
): Promise<HtmlDiagnostics> {
  const raw = await page.evaluate(
    ({ pageW, pageH }: { pageW: number; pageH: number }) => {
      function selectorFor(el: Element): string {
        const parts: string[] = [];
        let cur: Element | null = el;
        let depth = 0;
        while (cur && depth < 3) {
          let s = cur.tagName.toLowerCase();
          if (cur.id) { parts.unshift(`${s}#${cur.id}`); break; }
          const cls = (cur.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean);
          if (cls.length) s += `.${cls.slice(0, 2).join(".")}`;
          parts.unshift(s);
          cur = cur.parentElement;
          depth++;
        }
        return parts.join(" > ");
      }

      const docEl = document.documentElement;
      const body = document.body;
      const contentW = Math.max(docEl.scrollWidth, body?.scrollWidth ?? 0);
      const contentH = Math.max(docEl.scrollHeight, body?.scrollHeight ?? 0);

      const overflowing: Array<{
        tag: string; selector: string; text: string;
        overflowRightPx: number; overflowBottomPx: number;
      }> = [];
      const tolerance = 1;
      const seen = new Set<Element>();
      for (const el of Array.from(document.querySelectorAll("body *"))) {
        if (seen.has(el)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const overR = r.right - pageW;
        if (overR > tolerance) {
          let anc = el.parentElement;
          let ancReported = false;
          while (anc) {
            if (seen.has(anc)) { ancReported = true; break; }
            anc = anc.parentElement;
          }
          if (ancReported) continue;
          overflowing.push({
            tag: el.tagName.toLowerCase(),
            selector: selectorFor(el),
            text: ((el as HTMLElement).innerText ?? el.textContent ?? "").trim().slice(0, 80),
            overflowRightPx: Math.round(overR),
            overflowBottomPx: Math.round(Math.max(0, r.bottom - pageH)),
          });
          seen.add(el);
          if (overflowing.length >= 8) break;
        }
      }

      const imgs = Array.from(document.images);
      const broken = imgs.filter((img) => !(img.complete && img.naturalWidth > 0)).slice(0, 8)
        .map((img) => ({ src: img.src, width: img.naturalWidth, height: img.naturalHeight }));

      let pageCssDetected = false;
      try {
        for (const sheet of Array.from(document.styleSheets)) {
          let rules: CSSRuleList | null = null;
          try { rules = sheet.cssRules; } catch { continue; }
          if (!rules) continue;
          for (const rule of Array.from(rules)) {
            if (rule.constructor.name === "CSSPageRule" || rule.cssText.startsWith("@page")) {
              pageCssDetected = true; break;
            }
          }
          if (pageCssDetected) break;
        }
      } catch { /* ignore */ }

      const text = (body?.innerText ?? body?.textContent ?? "").trim();
      return {
        contentW, contentH, overflowing, broken,
        imageCount: imgs.length, textLength: text.length,
        title: document.title || null, pageCssDetected,
      };
    },
    { pageW: printableWidthPx, pageH: printableHeightPx },
  );

  const horizontalOverflowPx = Math.max(0, Math.round(raw.contentW - printableWidthPx));
  const estimatedPages = Math.max(1, Math.ceil(raw.contentH / printableHeightPx));

  const warnings: string[] = [];
  if (horizontalOverflowPx > 1) {
    warnings.push(
      `Content is ${horizontalOverflowPx}px wider than the printable area ` +
        `(${Math.round(raw.contentW)}px vs ${Math.round(printableWidthPx)}px printable; ` +
        `page is ${Math.round(paperWidthPx)}px with margins). ` +
        `Will be cut off or trigger extra pages.`,
    );
  }
  if (raw.broken.length > 0) {
    warnings.push(
      `${raw.broken.length} broken image(s). Images will appear blank. ` +
        `Fix by using absolute URLs, data URIs, or verified local paths.`,
    );
  }
  if (raw.textLength === 0 && raw.imageCount === 0) {
    warnings.push("No visible text or images detected — the PDF may be blank.");
  }
  if (raw.overflowing.length > 0) {
    warnings.push(`${raw.overflowing.length} element(s) overflow the right edge — see overflowingElements.`);
  }

  let advice: string[] = [];
  if (designLint) {
    try {
      const lintRes = (await page.evaluate(DESIGN_LINT_PROBES)) as { advice: string[] };
      advice = lintRes?.advice ?? [];
    } catch { /* best-effort */ }
  }

  return {
    paper: {
      widthPx: Math.round(paperWidthPx), heightPx: Math.round(paperHeightPx),
      widthIn: Math.round((paperWidthPx / PX_PER_INCH) * 100) / 100,
      heightIn: Math.round((paperHeightPx / PX_PER_INCH) * 100) / 100,
      label: paperLabel,
    },
    printable: {
      widthPx: Math.round(printableWidthPx), heightPx: Math.round(printableHeightPx),
    },
    contentWidthPx: Math.round(raw.contentW),
    contentHeightPx: Math.round(raw.contentH),
    estimatedPages, horizontalOverflowPx,
    overflowingElements: raw.overflowing,
    brokenImages: raw.broken,
    imageCount: raw.imageCount,
    textLength: raw.textLength,
    title: raw.title,
    pageCssDetected: raw.pageCssDetected,
    warnings, advice,
  };
}

function formatDiagnosticsBlock(d: HtmlDiagnostics): string {
  const sameAsPaper =
    d.printable.widthPx === d.paper.widthPx && d.printable.heightPx === d.paper.heightPx;
  const paperPart = sameAsPaper
    ? `paper=${d.paper.label} (${d.paper.widthPx}×${d.paper.heightPx}px, no margins)`
    : `paper=${d.paper.label} (${d.paper.widthPx}×${d.paper.heightPx}px, printable ${d.printable.widthPx}×${d.printable.heightPx}px)`;
  const lines: string[] = [[
    paperPart,
    `content=${d.contentWidthPx}×${d.contentHeightPx}px`,
    `~${d.estimatedPages}page${d.estimatedPages === 1 ? "" : "s"}`,
    `images=${d.imageCount}${d.brokenImages.length ? ` (${d.brokenImages.length} broken)` : ""}`,
    `text=${d.textLength}ch`,
  ].join(", ")];
  if (d.warnings.length) {
    lines.push("", "Warnings:");
    for (const w of d.warnings) lines.push(`  • ${w}`);
  }
  if (d.overflowingElements.length) {
    lines.push("", "Overflowing elements (first rows):");
    for (const el of d.overflowingElements.slice(0, 5)) {
      lines.push(`  • <${el.tag}> "${el.text.replace(/\s+/g, " ")}" — +${el.overflowRightPx}px right`);
      lines.push(`    ${el.selector}`);
    }
  }
  if (d.brokenImages.length) {
    lines.push("", "Broken images:");
    for (const img of d.brokenImages.slice(0, 5)) lines.push(`  • ${img.src || "(empty src)"}`);
  }
  if (d.advice.length) {
    lines.push("", "Design advice (non-blocking):");
    for (const a of d.advice) lines.push(`  • ${a}`);
  }
  return lines.join("\n");
}

// ── Option resolution (preset + overrides) ───────────────────────────────────

interface ResolvedOptions {
  paper: Paper;
  margins: Margins;
  theme: string | null;
  emulateMedia: "screen" | "print";
  preferCssPageSize: boolean;
  landscape: boolean;
  pageRanges: string | null;
  waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
  waitMs: number;
  designCheck: boolean;
  scale: number | null;
  printBackground: boolean;
  headerFooter: HeaderFooterPreset;
  customHeaderHtml: string | null;
  customFooterHtml: string | null;
}

function resolveOptions(params: Record<string, unknown>, toolName: string): ResolvedOptions {
  const presetName = ((params.preset as string | undefined) ?? "document").toLowerCase();
  const presetFactory = getPreset(presetName);
  if (!presetFactory) {
    throw new Error(
      `${toolName}: unknown preset "${params.preset}". ` +
        `Valid presets: ${listPresetNames().join(", ")}. ` +
        `Call html_style_guide for descriptions.`,
    );
  }
  const preset = presetFactory();

  let paper = preset.paper;
  if (params.paper !== undefined) {
    const parsed = parsePaper(String(params.paper));
    if (!parsed) {
      throw new Error(
        `${toolName}: cannot parse paper "${params.paper}". ` +
          `Use a format name (Letter, A4, Legal, Tabloid) or "WIDTH x HEIGHT" (e.g. "13.333in x 7.5in").`,
      );
    }
    paper = parsed;
  }
  const landscape = (params.landscape as boolean | undefined) ?? false;
  if (landscape && paper.format) {
    paper = paperFromFormat(paper.format, true);
  } else if (landscape) {
    paper = { widthIn: paper.heightIn, heightIn: paper.widthIn, format: null, label: `${paper.label} (landscape)` };
  }

  const margins = parseMargins(params.margins as string | undefined, preset.margins);

  let theme: string | null = preset.theme;
  if (params.theme !== undefined) {
    const t = params.theme as string;
    if (t === "none") theme = null;
    else theme = t;
  }

  const headerFooter = ((params.header_footer as string | undefined) ?? "none") as HeaderFooterPreset;
  if (!["none", "page-numbers", "title", "title-and-pages"].includes(headerFooter)) {
    throw new Error(
      `${toolName}: unknown header_footer "${headerFooter}". ` +
        `Valid: none, page-numbers, title, title-and-pages.`,
    );
  }

  const waitFor = params.wait_for as string | number | undefined;
  let waitUntil: ResolvedOptions["waitUntil"] = "networkidle";
  let waitMs = 0;
  if (waitFor !== undefined) {
    if (typeof waitFor === "number") waitMs = waitFor;
    else if (/^\d+$/.test(String(waitFor))) waitMs = parseInt(String(waitFor), 10);
    else if (["load", "domcontentloaded", "networkidle", "commit"].includes(String(waitFor))) {
      waitUntil = waitFor as ResolvedOptions["waitUntil"];
    } else {
      throw new Error(
        `${toolName}: wait_for must be a number (ms) or one of: load, domcontentloaded, networkidle, commit.`,
      );
    }
  }

  return {
    paper,
    margins,
    theme,
    emulateMedia:
      (params.emulate_screen as boolean | undefined) === true ? "screen" : preset.emulateMedia,
    preferCssPageSize: preset.preferCssPageSize,
    landscape,
    pageRanges: (params.page_ranges as string | undefined) ?? null,
    waitUntil,
    waitMs,
    designCheck: (params.design_check as boolean | undefined) ?? true,
    scale: (params.scale as number | undefined) ?? null,
    printBackground: true,
    headerFooter,
    customHeaderHtml: (params.custom_header_html as string | undefined) ?? null,
    customFooterHtml: (params.custom_footer_html as string | undefined) ?? null,
  };
}

// ── Core render ──────────────────────────────────────────────────────────────

interface RenderResult {
  diagnostics: HtmlDiagnostics;
  page: Page;
  opts: ResolvedOptions;
}

async function renderForDiagnostics(
  source: HtmlSource,
  opts: ResolvedOptions,
): Promise<RenderResult> {
  const paperW = opts.paper.widthIn * PX_PER_INCH;
  const paperH = opts.paper.heightIn * PX_PER_INCH;
  const printableW = Math.max(1, Math.round(paperW - opts.margins.left - opts.margins.right));
  const printableH = Math.max(1, Math.round(paperH - opts.margins.top - opts.margins.bottom));

  if (opts.theme && source.content !== null) {
    const css = themeCss(opts.theme, { paperWidthIn: paperW / PX_PER_INCH, paperHeightIn: paperH / PX_PER_INCH });
    source.content = injectStyle(source.content, css);
  }

  const browserCtx = await browserService.ensureBrowser();
  const page = await browserCtx.newPage();
  await page.setViewportSize({ width: printableW, height: printableH });
  await page.emulateMedia({ media: opts.emulateMedia });

  if (source.content !== null) {
    await page.setContent(source.content, { waitUntil: opts.waitUntil, timeout: 30_000 });
  } else {
    await page.goto(source.url!, { waitUntil: opts.waitUntil, timeout: 30_000 });
  }
  if (opts.waitMs > 0) await page.waitForTimeout(opts.waitMs);

  const diagnostics = await gatherDiagnostics(
    page,
    Math.round(paperW), Math.round(paperH),
    printableW, printableH,
    opts.paper.label,
    opts.designCheck,
  );

  return { diagnostics, page, opts };
}

// ── Shared schema fragments ──────────────────────────────────────────────────

const SOURCE_SCHEMA_PROPS = {
  html: { type: "string", description: "Inline HTML. Provide exactly one of html / path / url." },
  path: { type: "string", description: "Local .html file path (relative to cwd or absolute)." },
  url: { type: "string", description: "http(s) URL to render." },
};

function commonSchemaProps() {
  return {
    preset: {
      type: "string",
      enum: listPresetNames(),
      description:
        "One word controls paper size + margins + theme CSS. Pick based on output: " +
        "'document' (default, Letter report), 'a4', 'letter', 'legal', 'report' (Letter with 1in margins), " +
        "'letter-landscape', 'a4-landscape', 'deck' or 'slides-16x9' (13.333×7.5in), 'slides-4x3' (10×7.5in), " +
        "'minimal' (serif, plain), 'none' (no theme CSS, Letter with 0.5in margins).",
    },
    header_footer: {
      type: "string",
      enum: ["none", "page-numbers", "title", "title-and-pages"],
      description:
        "Pre-built header/footer templates. Default 'none'. " +
        "'page-numbers' = 'Page N of M' footer. 'title' = document title as header. " +
        "'title-and-pages' = both. Use custom_header_html/custom_footer_html for bespoke layouts.",
    },
    paper: {
      type: "string",
      description:
        "(Override) Paper size. Named format ('Letter', 'A4', 'Legal', 'Tabloid') " +
        "or 'WIDTH x HEIGHT' (e.g. '13.333in x 7.5in', '210mm x 297mm'). Overrides the preset's paper.",
    },
    margins: {
      type: "string",
      description:
        "(Override) Page margins — CSS shorthand like '0.5in', '1in 0.5in', or '1in 0.5in 0.5in 1in' " +
        "(top right bottom left). Overrides the preset's margins.",
    },
    landscape: { type: "boolean", description: "(Override) Force landscape orientation." },
    theme: {
      type: "string",
      description:
        "(Override) Theme name. Built-ins: document, deck, minimal. Use 'none' to disable theme injection. " +
        "Other names are looked up in the theme registry.",
    },
    page_ranges: { type: "string", description: "Subset of pages to print, e.g. '1-3,7'." },

    custom_header_html: {
      type: "string",
      description:
        "(Advanced) HTML template for page header. Use classes 'date', 'title', 'url', 'pageNumber', 'totalPages' " +
        "for dynamic values. Inline styles only.",
    },
    custom_footer_html: {
      type: "string",
      description: "(Advanced) HTML template for page footer. Same rules as custom_header_html.",
    },
    wait_for: {
      type: ["string", "number"],
      description:
        "(Advanced) Either milliseconds to wait after load (e.g. 500), or a Playwright event name " +
        "('load', 'domcontentloaded', 'networkidle' default, 'commit').",
    },
    emulate_screen: {
      type: "boolean",
      description: "(Advanced) Emulate 'screen' media instead of 'print'. Default false.",
    },
    design_check: {
      type: "boolean",
      description:
        "(Advanced) Run the design lint (line-height, font-size, heading structure, vh/vw) " +
        "and include non-blocking advice in the result. Default true.",
    },
    scale: { type: "number", description: "(Advanced) Render scale 0.1–2.0. Default 1." },
  };
}

const COOKBOOK = `\
FAST PATH — three arguments:

    html_to_pdf({ html, output_path, preset })

Pick preset by the document type you want:
    "document" (default) — Letter report, 0.75in margins, clean typography.
    "a4" / "letter" / "legal" — same but different paper.
    "letter-landscape" / "a4-landscape" — rotated.
    "report" — Letter with 1in margins (more formal).
    "deck" or "slides-16x9" — 13.333×7.5in slide deck, deck theme.
         Write one <section> per slide. Add class="title" for cover slide,
         class="dark" for dark background.
    "slides-4x3" — 10×7.5in legacy slide ratio.
    "minimal" — serif, centered column.
    "none" — no theme CSS (bring your own styling).

To add page numbers or document title to every page:
    header_footer: "page-numbers" | "title" | "title-and-pages"

ITERATE visually with html_check first: identical params, writes only a PNG.

OVERRIDES (rarely needed — preset handles 95% of cases):
    paper:   "Letter" | "A4" | "13.333in x 7.5in" | ...
    margins: "0.5in" | "1in 0.5in" (CSS shorthand)
    landscape: true
    theme: "document" | "deck" | "minimal" | "none"
    page_ranges: "1-3,7"

PITFALLS (avoid these):
  • Don't write inline paper-size / margin / font CSS unless you have a reason —
    let the preset handle geometry.
  • Font sizes in inches overflow (\`font-size: 2in\` = 144pt). Use pt/px.
  • vh/vw are unreliable in print — prefer in/cm/mm/%.
  • position: fixed repeats or disappears — use header_footer for recurring content.
  • Broken images render blank — use absolute https:// URLs or data: URIs.

DIAGNOSTICS always returned:
  • paper + printable area + estimated page count
  • horizontal overflow with offending element selectors
  • broken image URLs
  • design advice (line-height, font-size, line length, heading structure, vh/vw usage)

CALL html_style_guide to read the baked-in CSS or the full recipe list.`;

// ── html_to_pdf tool ─────────────────────────────────────────────────────────

export class HtmlToPdfTool extends BaseTool {
  readonly name = "html_to_pdf";
  readonly tags = ["pdf", "html", "write"] as const;
  readonly description = `Render HTML to a polished PDF. Pass one of html/path/url plus output_path — the default preset handles typography, margins, and paper size.

${COOKBOOK}`;
  get inputSchema() {
    return {
      type: "object" as const,
      properties: {
        ...SOURCE_SCHEMA_PROPS,
        output_path: {
          type: "string",
          description: "Where to write the PDF (relative to cwd or absolute). '.pdf' added if omitted.",
        },
        preview_image: {
          type: ["boolean", "string"],
          description:
            "Save a PNG preview alongside the PDF. Pass true to auto-name " +
            "(output_path with .png extension) or a path string to choose the name.",
        },
        ...commonSchemaProps(),
      },
      required: ["output_path"],
    };
  }

  async run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutorResult> {
    const source = await resolveHtmlSource(params, ctx.cwd, this.name);
    const opts = resolveOptions(params, this.name);

    let outPath = resolveToCwd(params.output_path as string, ctx.cwd);
    if (!outPath.toLowerCase().endsWith(".pdf")) outPath += ".pdf";

    const previewRaw = params.preview_image;
    let previewPath: string | null = null;
    if (typeof previewRaw === "string" && previewRaw) {
      previewPath = resolveToCwd(previewRaw, ctx.cwd);
      if (!previewPath.toLowerCase().endsWith(".png")) previewPath += ".png";
    } else if (previewRaw === true) {
      previewPath = outPath.replace(/\.pdf$/i, ".png");
    }

    const { diagnostics, page } = await renderForDiagnostics(source, opts);

    try {
      if (previewPath) {
        await page.screenshot({ path: previewPath, fullPage: true, type: "png" });
      }

      const { header, footer } = resolveHeaderFooter(
        opts.headerFooter, opts.customHeaderHtml ?? undefined, opts.customFooterHtml ?? undefined,
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pdfOpts: any = {
        path: outPath,
        printBackground: opts.printBackground,
        margin: marginsToPdfOpt(opts.margins),
        landscape: opts.landscape && opts.paper.format !== null,
      };
      if (opts.paper.format) pdfOpts.format = opts.paper.format;
      else {
        pdfOpts.width = `${opts.paper.widthIn}in`;
        pdfOpts.height = `${opts.paper.heightIn}in`;
      }
      if (opts.preferCssPageSize) pdfOpts.preferCSSPageSize = true;
      if (opts.scale !== null) pdfOpts.scale = opts.scale;
      if (opts.pageRanges) pdfOpts.pageRanges = opts.pageRanges;
      if (header !== null || footer !== null) {
        pdfOpts.displayHeaderFooter = true;
        pdfOpts.headerTemplate = header ?? "<div></div>";
        pdfOpts.footerTemplate = footer ?? "<div></div>";
      }

      await page.pdf(pdfOpts);
      const st = await stat(outPath);

      const lines = [
        `Saved PDF to: ${outPath} (${formatBytes(st.size)})`,
        formatDiagnosticsBlock(diagnostics),
      ];
      if (previewPath) lines.push(`Preview image: ${previewPath}`);
      return lines.join("\n");
    } finally {
      await page.close();
    }
  }
}

// ── html_check tool ──────────────────────────────────────────────────────────

export class HtmlCheckTool extends BaseTool {
  readonly name = "html_check";
  readonly tags = ["pdf", "html", "check"] as const;
  readonly description = `Dry-run the PDF render — returns diagnostics and optionally writes a PNG preview, but does NOT produce a PDF. Same parameters as html_to_pdf so you can iterate on layout cheaply then swap the tool name once it looks right.

${COOKBOOK}`;
  get inputSchema() {
    return {
      type: "object" as const,
      properties: {
        ...SOURCE_SCHEMA_PROPS,
        preview_image: {
          type: ["boolean", "string"],
          description:
            "Write a PNG preview. If a string, use that path. If true, auto-names a file in cwd. " +
            "Defaults to false (diagnostics only).",
        },
        ...commonSchemaProps(),
      },
      required: [],
    };
  }

  async run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutorResult> {
    const source = await resolveHtmlSource(params, ctx.cwd, this.name);
    const opts = resolveOptions(params, this.name);

    const previewRaw = params.preview_image;
    let previewPath: string | null = null;
    if (typeof previewRaw === "string" && previewRaw) {
      previewPath = resolveToCwd(previewRaw, ctx.cwd);
      if (!previewPath.toLowerCase().endsWith(".png")) previewPath += ".png";
    } else if (previewRaw === true) {
      previewPath = resolveToCwd(`html-check-${Date.now()}.png`, ctx.cwd);
    }

    const { diagnostics, page } = await renderForDiagnostics(source, opts);

    try {
      if (previewPath) {
        await page.screenshot({ path: previewPath, fullPage: true, type: "png" });
      }
      const lines = [
        `html_check: ${source.description}`,
        formatDiagnosticsBlock(diagnostics),
      ];
      if (previewPath) lines.push(`Preview image: ${previewPath}`);
      return lines.join("\n");
    } finally {
      await page.close();
    }
  }
}

// ── html_style_guide tool ────────────────────────────────────────────────────

export class HtmlStyleGuideTool extends BaseTool {
  readonly name = "html_style_guide";
  readonly tags = ["pdf", "html", "reference"] as const;
  readonly description =
    `Print the built-in CSS and/or the cookbook used by html_to_pdf. Call this before writing HTML if you want to see exactly what each preset/theme applies.

Sections:
    "cookbook" (default) — paper presets, recipes, pitfalls, typography primer.
    "presets"            — table of all presets with their paper / margins / theme.
    "document"           — the CSS injected by theme='document'.
    "deck"               — the CSS injected by theme='deck' (for 13.333in × 7.5in).
    "minimal"            — the CSS injected by theme='minimal'.
    "all"                — every section concatenated.`;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      section: {
        type: "string",
        enum: ["cookbook", "presets", "document", "deck", "minimal", "all"],
        description: "Which section to return. Default 'cookbook'.",
      },
    },
    required: [],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const section = ((params.section as string | undefined) ?? "cookbook") as
      | "cookbook" | "presets" | "document" | "deck" | "minimal" | "all";
    const deckCtx = { paperWidthIn: 13.333, paperHeightIn: 7.5 };

    const parts: string[] = [];
    if (section === "cookbook" || section === "all") parts.push("# Cookbook\n\n" + COOKBOOK);
    if (section === "presets" || section === "all") parts.push("# Presets\n\n" + formatPresetTable());
    if (section === "document" || section === "all")
      parts.push("# theme=\"document\" CSS\n\n```css\n" + themeCss("document", deckCtx) + "\n```");
    if (section === "deck" || section === "all")
      parts.push(`# theme="deck" CSS (for 13.333in × 7.5in)\n\n\`\`\`css\n${themeCss("deck", deckCtx)}\n\`\`\``);
    if (section === "minimal" || section === "all")
      parts.push("# theme=\"minimal\" CSS\n\n```css\n" + themeCss("minimal", deckCtx) + "\n```");
    return Promise.resolve(parts.join("\n\n"));
  }
}

function formatPresetTable(): string {
  const rows = listPresetNames().map((name) => {
    const factory = getPreset(name)!;
    const p = factory();
    const m = p.margins;
    const allSame = m.top === m.right && m.right === m.bottom && m.bottom === m.left;
    const mStr = allSame
      ? `${(m.top / PX_PER_INCH).toFixed(2)}in`
      : `${(m.top / PX_PER_INCH).toFixed(2)}/${(m.right / PX_PER_INCH).toFixed(2)}/${(m.bottom / PX_PER_INCH).toFixed(2)}/${(m.left / PX_PER_INCH).toFixed(2)}in`;
    return `  ${name.padEnd(18)} paper=${p.paper.label.padEnd(22)} margins=${mStr.padEnd(12)} theme=${p.theme ?? "none"}`;
  });
  return rows.join("\n");
}

// ── Utilities ────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

// ── Default instances (legacy export shape) ──────────────────────────────────

export const htmlToPdfTool = new HtmlToPdfTool();
export const htmlCheckTool = new HtmlCheckTool();
export const htmlStyleGuideTool = new HtmlStyleGuideTool();

export {
  parseLengthToPx,
  parseMargins,
  parsePaper,
  gatherDiagnostics,
};
