/**
 * Preset registry for html_to_pdf / html_check.
 *
 * A preset bundles paper size + margins + theme + media + page-size flags.
 * Built-in presets register themselves on import. Callers can register
 * their own with {@link registerPreset} before constructing the tools.
 */

export type PdfFormat =
  | "Letter" | "Legal" | "Tabloid" | "Ledger"
  | "A0" | "A1" | "A2" | "A3" | "A4" | "A5" | "A6";

const PX_PER_INCH = 96;

const FORMAT_INCHES: Record<PdfFormat, { w: number; h: number }> = {
  Letter: { w: 8.5, h: 11 },
  Legal: { w: 8.5, h: 14 },
  Tabloid: { w: 11, h: 17 },
  Ledger: { w: 17, h: 11 },
  A0: { w: 33.1, h: 46.8 },
  A1: { w: 23.4, h: 33.1 },
  A2: { w: 16.5, h: 23.4 },
  A3: { w: 11.7, h: 16.5 },
  A4: { w: 8.27, h: 11.69 },
  A5: { w: 5.83, h: 8.27 },
  A6: { w: 4.13, h: 5.83 },
};

export { PX_PER_INCH, FORMAT_INCHES };

export interface Margins { top: number; right: number; bottom: number; left: number }

export interface Paper {
  widthIn: number;
  heightIn: number;
  /** Either a named format (passed to Playwright) or null for a custom size. */
  format: PdfFormat | null;
  /** Human label for diagnostics. */
  label: string;
}

export interface Preset {
  paper: Paper;
  margins: Margins;
  /** Theme name, or null to skip theme injection. */
  theme: string | null;
  emulateMedia: "screen" | "print";
  preferCssPageSize: boolean;
}

export type PresetFactory = () => Preset;

const presets = new Map<string, PresetFactory>();

/** Register or override a preset. Names are case-insensitive. */
export function registerPreset(name: string, factory: PresetFactory): void {
  presets.set(name.toLowerCase(), factory);
}

/** Lookup a preset by name (case-insensitive). */
export function getPreset(name: string): PresetFactory | undefined {
  return presets.get(name.toLowerCase());
}

/** Names of every registered preset. */
export function listPresetNames(): string[] {
  return [...presets.keys()];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function marginsFromIn(all: number): Margins;
export function marginsFromIn(v: { t: number; r: number; b: number; l: number }): Margins;
export function marginsFromIn(v: number | { t: number; r: number; b: number; l: number }): Margins {
  if (typeof v === "number") {
    const px = v * PX_PER_INCH;
    return { top: px, right: px, bottom: px, left: px };
  }
  return {
    top: v.t * PX_PER_INCH,
    right: v.r * PX_PER_INCH,
    bottom: v.b * PX_PER_INCH,
    left: v.l * PX_PER_INCH,
  };
}

export function paperFromFormat(f: PdfFormat, landscape = false): Paper {
  const { w, h } = FORMAT_INCHES[f];
  return landscape
    ? { widthIn: h, heightIn: w, format: f, label: `${f} (landscape)` }
    : { widthIn: w, heightIn: h, format: f, label: f };
}

export function paperCustom(w: number, h: number, label: string): Paper {
  return { widthIn: w, heightIn: h, format: null, label };
}

// ── Length + paper parsing ───────────────────────────────────────────────────

/** Parse a CSS length (in/cm/mm/pt/pc/px) into CSS pixels at 96 DPI. NaN on failure. */
export function parseLengthToPx(value: string | undefined): number {
  if (value === undefined) return NaN;
  const m = String(value).trim().match(/^(-?\d*\.?\d+)\s*(in|cm|mm|pt|pc|px)?$/i);
  if (!m) return NaN;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "px").toLowerCase();
  switch (unit) {
    case "in": return n * PX_PER_INCH;
    case "cm": return (n / 2.54) * PX_PER_INCH;
    case "mm": return (n / 25.4) * PX_PER_INCH;
    case "pt": return (n / 72) * PX_PER_INCH;
    case "pc": return (n / 6) * PX_PER_INCH;
    default: return n;
  }
}

/**
 * Parse a CSS-shorthand margin string into four pixel values.
 *   "0"                       → 0 all sides
 *   "1in"                     → 1in all sides
 *   "0.5in 1in"               → top/bottom=0.5in, left/right=1in
 *   "0.5in 1in 0.25in"        → top=0.5in, L/R=1in, bottom=0.25in
 *   "0.5in 1in 0.25in 0.75in" → T R B L
 */
export function parseMargins(input: string | undefined, fallback: Margins): Margins {
  if (!input) return fallback;
  const tokens = input.trim().split(/\s+/);
  const vals = tokens.map(parseLengthToPx);
  if (vals.some((v) => !Number.isFinite(v))) return fallback;
  switch (vals.length) {
    case 1: return { top: vals[0]!, right: vals[0]!, bottom: vals[0]!, left: vals[0]! };
    case 2: return { top: vals[0]!, right: vals[1]!, bottom: vals[0]!, left: vals[1]! };
    case 3: return { top: vals[0]!, right: vals[1]!, bottom: vals[2]!, left: vals[1]! };
    case 4: return { top: vals[0]!, right: vals[1]!, bottom: vals[2]!, left: vals[3]! };
    default: return fallback;
  }
}

/**
 * Parse a paper string.
 *   "Letter", "A4", "Legal" — named format
 *   "13.333in x 7.5in"      — custom (accepts "x" or "×")
 *   "8.5in × 11in"          — custom
 *   "210mm x 297mm"         — custom with different units
 */
export function parsePaper(input: string): Paper | null {
  const trimmed = input.trim();
  for (const f of Object.keys(FORMAT_INCHES) as PdfFormat[]) {
    if (f.toLowerCase() === trimmed.toLowerCase()) {
      const size = FORMAT_INCHES[f];
      return { widthIn: size.w, heightIn: size.h, format: f, label: f };
    }
  }
  const m = trimmed.match(/^(\S+)\s*[x×]\s*(\S+)$/i);
  if (m) {
    const w = parseLengthToPx(m[1]) / PX_PER_INCH;
    const h = parseLengthToPx(m[2]) / PX_PER_INCH;
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      return { widthIn: w, heightIn: h, format: null, label: `${m[1]} × ${m[2]}` };
    }
  }
  return null;
}

/** Margins → Playwright PdfMargin shape (CSS length strings). */
export function marginsToPdfOpt(m: Margins): { top: string; right: string; bottom: string; left: string } {
  const pxToIn = (px: number) => `${(px / PX_PER_INCH).toFixed(4)}in`;
  return { top: pxToIn(m.top), right: pxToIn(m.right), bottom: pxToIn(m.bottom), left: pxToIn(m.left) };
}

// ── Built-in presets ─────────────────────────────────────────────────────────

registerPreset("document", () => ({
  paper: paperFromFormat("Letter"),
  margins: marginsFromIn(0.75),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("report", () => ({
  paper: paperFromFormat("Letter"),
  margins: marginsFromIn(1),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("letter", () => ({
  paper: paperFromFormat("Letter"),
  margins: marginsFromIn(0.75),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("letter-landscape", () => ({
  paper: paperFromFormat("Letter", true),
  margins: marginsFromIn(0.75),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("a4", () => ({
  paper: paperFromFormat("A4"),
  margins: marginsFromIn(0.75),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("a4-landscape", () => ({
  paper: paperFromFormat("A4", true),
  margins: marginsFromIn(0.75),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("legal", () => ({
  paper: paperFromFormat("Legal"),
  margins: marginsFromIn(0.75),
  theme: "document",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("deck", () => ({
  paper: paperCustom(13.333, 7.5, "13.333in × 7.5in"),
  margins: marginsFromIn(0),
  theme: "deck",
  emulateMedia: "print",
  preferCssPageSize: true,
}));
registerPreset("slides-16x9", () => ({
  paper: paperCustom(13.333, 7.5, "13.333in × 7.5in"),
  margins: marginsFromIn(0),
  theme: "deck",
  emulateMedia: "print",
  preferCssPageSize: true,
}));
registerPreset("slides-4x3", () => ({
  paper: paperCustom(10, 7.5, "10in × 7.5in"),
  margins: marginsFromIn(0),
  theme: "deck",
  emulateMedia: "print",
  preferCssPageSize: true,
}));
registerPreset("minimal", () => ({
  paper: paperFromFormat("Letter"),
  margins: marginsFromIn(1),
  theme: "minimal",
  emulateMedia: "print",
  preferCssPageSize: false,
}));
registerPreset("none", () => ({
  paper: paperFromFormat("Letter"),
  margins: marginsFromIn(0.5),
  theme: null,
  emulateMedia: "print",
  preferCssPageSize: false,
}));
