/**
 * Theme registry for html_to_pdf / html_check.
 *
 * A theme is a CSS snippet injected at the top of the document's <head>.
 * Built-in themes ship with the package; callers can register their own
 * via {@link registerTheme} before constructing the tools.
 *
 * User-authored CSS still wins (later rules override). All built-in themes
 * use px/pt (never vh/vw) and include `print-color-adjust: exact` so
 * backgrounds survive to the PDF.
 */

export interface ThemeContext {
  /** Paper width in inches AFTER landscape swap. */
  paperWidthIn: number;
  /** Paper height in inches AFTER landscape swap. */
  paperHeightIn: number;
}

export type ThemeFactory = (ctx: ThemeContext) => string;

const themes = new Map<string, ThemeFactory>();

/** Register or override a theme. Names are case-insensitive. */
export function registerTheme(name: string, factory: ThemeFactory): void {
  themes.set(name.toLowerCase(), factory);
}

/** Theme names currently registered. */
export function listThemeNames(): string[] {
  return [...themes.keys()];
}

/** Lookup a theme factory by name (case-insensitive). */
export function getTheme(name: string): ThemeFactory | undefined {
  return themes.get(name.toLowerCase());
}

/** Returns the CSS for `name`, or throws if no such theme is registered. */
export function themeCss(name: string, ctx: ThemeContext): string {
  const f = themes.get(name.toLowerCase());
  if (!f) throw new Error(`Unknown theme "${name}". Known: ${listThemeNames().join(", ")}.`);
  return f(ctx);
}

/**
 * Built-in theme name. Kept as a string-literal union for back-compat with
 * code that imports the type, but new themes registered at runtime are
 * also accepted by `themeCss(name)`.
 */
export type ThemeName = "document" | "deck" | "minimal";

/**
 * Inject `<style>{css}</style>` into the HTML at the top of <head>.
 * - If <head> is missing, injects a <head> with the style.
 * - If <html> is missing, wraps the content in <!doctype html><html><head>…</head><body>…</body></html>.
 * Case-insensitive tag matching.
 */
export function injectStyle(html: string, css: string): string {
  const styleTag = `<style data-agentic-theme>${css}</style>`;

  const headOpen = html.match(/<head(\s[^>]*)?>/i);
  if (headOpen) {
    const i = headOpen.index! + headOpen[0].length;
    return html.slice(0, i) + styleTag + html.slice(i);
  }

  const htmlOpen = html.match(/<html(\s[^>]*)?>/i);
  if (htmlOpen) {
    const i = htmlOpen.index! + htmlOpen[0].length;
    return html.slice(0, i) + `<head>${styleTag}</head>` + html.slice(i);
  }

  const hasDoctype = /^\s*<!doctype/i.test(html);
  return (
    (hasDoctype ? "" : "<!doctype html>") +
    `<html><head>${styleTag}</head><body>${html}</body></html>`
  );
}

// ── Built-in themes ──────────────────────────────────────────────────────────

const DOCUMENT_THEME = `
:root { color-scheme: light; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt;
  line-height: 1.55;
  color: #1f2328;
  max-width: 6.5in;
  margin: 0 auto;
  padding: 0;
  -webkit-font-smoothing: antialiased;
}
h1, h2, h3, h4 { font-weight: 600; letter-spacing: -0.01em; line-height: 1.25; margin-top: 18pt; }
h1 {
  font-size: 22pt; margin: 0 0 10pt; padding-bottom: 6pt;
  border-bottom: 1pt solid #d0d7de;
}
h2 { font-size: 15pt; margin: 20pt 0 6pt; }
h3 { font-size: 12pt; margin: 14pt 0 4pt; }
h4 { font-size: 11pt; margin: 12pt 0 4pt; color: #57606a; }
p { margin: 6pt 0; }
ul, ol { margin: 6pt 0; padding-left: 22pt; }
li { margin: 2pt 0; }
a { color: #0969da; text-decoration: none; }
a:hover { text-decoration: underline; }
strong { font-weight: 600; }
em { font-style: italic; }
small { font-size: 9pt; color: #57606a; }
code, pre, kbd, samp {
  font-family: "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  font-size: 9.5pt;
}
code {
  background: #f6f8fa; padding: 1pt 5pt; border-radius: 4px;
  font-size: 9.5pt; word-break: break-word;
}
pre {
  background: #f6f8fa; padding: 10pt 12pt; border-radius: 6px;
  white-space: pre-wrap; word-break: break-word; overflow: hidden;
  font-size: 9.5pt; line-height: 1.45;
  margin: 10pt 0;
}
pre code { background: transparent; padding: 0; }
table {
  border-collapse: collapse; width: 100%; margin: 10pt 0;
  font-size: 10pt; table-layout: auto;
}
th, td { border: 0.5pt solid #d0d7de; padding: 5pt 9pt; text-align: left; vertical-align: top; }
th { background: #f6f8fa; font-weight: 600; }
tr:nth-child(even) td { background: #fafbfc; }
blockquote {
  margin: 10pt 0; padding: 4pt 14pt;
  border-left: 3pt solid #d0d7de; color: #57606a; font-style: italic;
}
hr { border: none; border-top: 0.5pt solid #d0d7de; margin: 16pt 0; }
img { max-width: 100%; height: auto; }
/* Don't split atoms across pages. */
h1, h2, h3, h4, pre, blockquote, tr, img { page-break-inside: avoid; break-inside: avoid; }
h1, h2, h3 { page-break-after: avoid; break-after: avoid; }
`.trim();

function deckTheme(w: number, h: number): string {
  return `
:root { color-scheme: light; }
html, body { margin: 0; padding: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif;
  font-size: 20pt; line-height: 1.45;
  color: #0f1c2e;
  -webkit-print-color-adjust: exact; print-color-adjust: exact;
  -webkit-font-smoothing: antialiased;
}
@page { size: ${w}in ${h}in; margin: 0; }
section {
  box-sizing: border-box;
  width: ${w}in; height: ${h}in;
  padding: 0.6in 0.8in;
  page-break-after: always; break-after: page;
  overflow: hidden;
  display: flex; flex-direction: column; justify-content: center;
  background: #ffffff;
  position: relative;
}
section:last-child { page-break-after: auto; break-after: auto; }
section.title {
  background: linear-gradient(135deg, #0b3d91 0%, #1a73e8 100%);
  color: #ffffff; text-align: center; justify-content: center;
}
section.title h1 {
  font-size: 60pt; margin: 0 0 0.2in; letter-spacing: -2pt;
  font-weight: 800; line-height: 1.05;
}
section.title p { font-size: 22pt; margin: 0; opacity: 0.9; line-height: 1.3; }
section h1 {
  font-size: 40pt; margin: 0 0 0.25in; color: #0b3d91;
  letter-spacing: -1pt; font-weight: 700; line-height: 1.1;
}
section h2 {
  font-size: 26pt; margin: 0 0 0.15in; color: #0b3d91; font-weight: 600;
}
section p, section li { font-size: 20pt; line-height: 1.45; }
section p { margin: 0.1in 0; }
section ul, section ol { padding-left: 0.4in; margin: 0.1in 0; }
section li { margin-bottom: 0.12in; }
section strong { color: #0b3d91; }
section img, section svg { max-width: 100%; height: auto; }
section.dark { background: #0f1c2e; color: #ffffff; }
section.dark h1, section.dark h2, section.dark strong { color: #ffffff; }
section .footer {
  position: absolute; bottom: 0.3in; right: 0.8in; left: 0.8in;
  font-size: 10pt; color: #8b95a3; display: flex; justify-content: space-between;
}
`.trim();
}

const MINIMAL_THEME = `
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  font-family: Georgia, "Times New Roman", serif;
  font-size: 11pt; line-height: 1.6; color: #000;
  max-width: 6.5in; margin: 0 auto;
}
h1, h2, h3 { font-weight: normal; letter-spacing: 0.01em; }
h1 { font-size: 20pt; margin: 0 0 10pt; }
h2 { font-size: 14pt; margin: 16pt 0 6pt; }
h3 { font-size: 12pt; margin: 12pt 0 4pt; }
p { margin: 6pt 0; text-indent: 0; }
img { max-width: 100%; height: auto; }
`.trim();

registerTheme("document", () => DOCUMENT_THEME);
registerTheme("deck", (ctx) => deckTheme(ctx.paperWidthIn, ctx.paperHeightIn));
registerTheme("minimal", () => MINIMAL_THEME);

// ── Design lint ──────────────────────────────────────────────────────────────

/**
 * Pure-HTML/CSS heuristics for "does this look good?". Non-blocking advice —
 * surfaced separately from correctness warnings. Keeps a small curated set of
 * high-signal checks rather than a sprawling linter.
 */
export const DESIGN_LINT_PROBES = `
(() => {
  const body = document.body;
  if (!body) return { advice: [] };
  const bodyStyle = getComputedStyle(body);
  const advice = [];

  // Font family
  const ff = bodyStyle.fontFamily || "";
  if (!ff || /^Times/.test(ff) && !/serif/i.test(ff)) {
    advice.push("Body uses the browser default serif. Set an explicit font-family (e.g. a system stack) for consistent typography.");
  }

  // Font size (too small)
  const fontPx = parseFloat(bodyStyle.fontSize);
  if (fontPx && fontPx < 12) { // < 9pt
    advice.push(\`Body font-size is ~\${Math.round(fontPx)}px. Print bodies read best at 10–12pt (13–16px).\`);
  }

  // Line height
  const lh = bodyStyle.lineHeight;
  const fs = parseFloat(bodyStyle.fontSize);
  let lhRatio = null;
  if (lh && lh !== "normal" && fs) lhRatio = parseFloat(lh) / fs;
  if (lhRatio !== null && lhRatio < 1.3) {
    advice.push(\`Tight line-height (\${lhRatio.toFixed(2)}×). Set line-height: 1.5 on body for readable print text.\`);
  } else if (lh === "normal") {
    advice.push("Body line-height is 'normal' — set an explicit 1.5 for readable body copy.");
  }

  // Line length — check widest paragraph
  const paragraphs = Array.from(document.querySelectorAll("p, li"));
  let widestChLength = 0;
  for (const p of paragraphs.slice(0, 40)) {
    const text = (p.textContent || "").trim();
    if (text.length < 80) continue;
    const w = p.getBoundingClientRect().width;
    // approximate char width at 0.5em
    const est = w / (parseFloat(getComputedStyle(p).fontSize) * 0.5);
    if (est > widestChLength) widestChLength = est;
  }
  if (widestChLength > 95) {
    advice.push(\`Line length ~\${Math.round(widestChLength)} characters. Cap body text around 65–80ch (max-width: ~6.5in at 11pt) for readability.\`);
  }

  // Heading structure for long docs
  const bodyText = (body.innerText || body.textContent || "");
  const wordCount = bodyText.split(/\\s+/).filter(Boolean).length;
  const headings = document.querySelectorAll("h1, h2, h3").length;
  if (wordCount > 200 && headings === 0) {
    advice.push(\`Long document (\${wordCount} words) with no headings. Add <h1>/<h2> for scannability and page-break control.\`);
  }

  // Viewport units in user CSS
  let vhFound = false;
  try {
    for (const sheet of Array.from(document.styleSheets)) {
      if ((sheet.ownerNode && sheet.ownerNode.getAttribute &&
           sheet.ownerNode.getAttribute("data-agentic-theme"))) continue;
      let rules = null;
      try { rules = sheet.cssRules; } catch { continue; }
      if (!rules) continue;
      for (const rule of Array.from(rules)) {
        if (/\\b\\d+v[hw]\\b/.test(rule.cssText || "")) { vhFound = true; break; }
      }
      if (vhFound) break;
    }
  } catch { /* ignore */ }
  if (vhFound) {
    advice.push("CSS uses vh/vw units — unreliable in print. Use in/cm/mm/% or concrete pixel values.");
  }

  // Large single paragraph (no structure)
  for (const p of paragraphs.slice(0, 40)) {
    if ((p.textContent || "").length > 1200) {
      advice.push("A single <p> exceeds 1200 characters. Break long prose into multiple paragraphs — walls of text are hard to read.");
      break;
    }
  }

  return { advice };
})()
`.trim();
