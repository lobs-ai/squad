/**
 * PptxGenJS tools — create PowerPoint presentations from an agent.
 *
 * Presentations are held in memory (keyed by ID) across tool calls within
 * a single agent run. Call pptx_save at the end to write the .pptx file.
 *
 * Coordinate system: all x, y, w, h values are in **inches**.
 * Default 16:9 slide canvas = 10 × 5.625 inches.
 *
 * Usage pattern:
 *   1. pptx_create        → get presentationId
 *   2. pptx_add_slide     → get slideIndex (1-based)
 *   3. pptx_add_text / pptx_add_image / pptx_add_shape / etc.
 *   4. pptx_save          → write .pptx to disk
 */

// NodeNext module resolution + pptxgenjs UMD types lose the construct signature,
// so we define minimal local interfaces for the subset we use and dynamically
// import the module at first use (pptxgenjs is an optional peer dependency).
import { randomBytes } from "node:crypto";
import { BaseTool, type ToolContext } from "./base-tool.js";
import type { ToolExecutorResult } from "./types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOpts = Record<string, any>;

interface PptxSlide {
  background: AnyOpts;
  addNotes(notes: string): void;
  addText(text: string | AnyOpts[], opts?: AnyOpts): PptxSlide;
  addImage(opts: AnyOpts): PptxSlide;
  addShape(shape: string, opts?: AnyOpts): PptxSlide;
  addTable(rows: AnyOpts[][], opts?: AnyOpts): PptxSlide;
  addChart(type: string, data: AnyOpts[], opts?: AnyOpts): PptxSlide;
}

interface PptxPresentation {
  title: string;
  author: string;
  company: string;
  layout: string;
  addSlide(opts?: AnyOpts): PptxSlide;
  writeFile(opts: { fileName: string }): Promise<string>;
}

type PptxConstructor = new () => PptxPresentation;

let _pptxCtor: PptxConstructor | null = null;
async function loadPptxCtor(): Promise<PptxConstructor> {
  if (_pptxCtor) return _pptxCtor;
  try {
    const mod = await import("pptxgenjs");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    _pptxCtor = ((mod as any).default ?? mod) as unknown as PptxConstructor;
    return _pptxCtor;
  } catch (err) {
    throw new Error(
      `The pptx tools require the "pptxgenjs" peer dependency. Install it with: npm install pptxgenjs`,
      { cause: err },
    );
  }
}

// ── Shared in-memory state ────────────────────────────────────────────────────

interface PresEntry {
  pres: PptxPresentation;
  slides: PptxSlide[];
}

const _store = new Map<string, PresEntry>();

function getEntry(id: string): PresEntry {
  const entry = _store.get(id);
  if (!entry) throw new Error(`Presentation "${id}" not found — call pptx_create first.`);
  return entry;
}

function getSlide(id: string, slideNum: number): PptxSlide {
  const { slides } = getEntry(id);
  const slide = slides[slideNum - 1];
  if (!slide) throw new Error(`Slide ${slideNum} does not exist in presentation "${id}".`);
  return slide;
}

// ── Shape name aliases → pptxgenjs SHAPE_NAME strings ────────────────────────

const SHAPE_ALIASES: Record<string, string> = {
  rect: "rect", rectangle: "rect",
  oval: "ellipse", ellipse: "ellipse", circle: "ellipse",
  "rounded-rect": "roundRect", rounded_rect: "roundRect", roundRect: "roundRect",
  triangle: "triangle",
  diamond: "diamond",
  line: "line",
  "right-arrow": "rightArrow", right_arrow: "rightArrow", rightArrow: "rightArrow",
  "left-arrow": "leftArrow", left_arrow: "leftArrow", leftArrow: "leftArrow",
  "up-arrow": "upArrow", up_arrow: "upArrow", upArrow: "upArrow",
  "down-arrow": "downArrow", down_arrow: "downArrow", downArrow: "downArrow",
  star: "star5", star4: "star4", star5: "star5", star6: "star6",
  star8: "star8", star10: "star10",
  hexagon: "hexagon", pentagon: "pentagon",
  cross: "plus", plus: "plus",
  cloud: "cloud", cube: "cube", cylinder: "cylinder",
};

function resolveShape(name: string): string {
  return SHAPE_ALIASES[name] ?? name;
}

// ── Chart type aliases ────────────────────────────────────────────────────────

const CHART_ALIASES: Record<string, string> = {
  area: "area",
  bar: "bar", horizontal_bar: "bar",
  col: "bar", column: "bar",
  bar3d: "bar3D", "3d-bar": "bar3D",
  bubble: "bubble",
  doughnut: "doughnut", donut: "doughnut",
  line: "line",
  pie: "pie",
  radar: "radar",
  scatter: "scatter",
};

// ── Default drop shadow ───────────────────────────────────────────────────────

const DEFAULT_SHADOW: AnyOpts = {
  type: "outer",
  color: "000000",
  blur: 4,
  opacity: 0.4,
  offset: 2,
  angle: 45,
};

// ── pptx_create ───────────────────────────────────────────────────────────────

export class PptxCreateTool extends BaseTool {
  readonly name = "pptx_create";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Create a new PowerPoint presentation in memory. Returns a presentationId used by all other pptx_ tools. " +
    "Layout options: LAYOUT_16x9 (10×5.625\"), LAYOUT_4x3 (10×7.5\"), LAYOUT_WIDE (13.33×7.5\").";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      title: { type: "string", description: "Presentation title" },
      author: { type: "string", description: "Author name" },
      company: { type: "string", description: "Company name" },
      layout: {
        type: "string",
        enum: ["LAYOUT_16x9", "LAYOUT_4x3", "LAYOUT_WIDE", "LAYOUT_16x10"],
        description: "Slide layout (default: LAYOUT_16x9)",
      },
    },
    required: [],
  };

  async run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const id = randomBytes(4).toString("hex");
    const PptxCtor = await loadPptxCtor();
    const pres = new PptxCtor();

    if (params.title) pres.title = params.title as string;
    if (params.author) pres.author = params.author as string;
    if (params.company) pres.company = params.company as string;
    if (params.layout) pres.layout = params.layout as string;

    _store.set(id, { pres, slides: [] });

    const layout = (params.layout as string | undefined) ?? "LAYOUT_16x9";
    const dims =
      layout === "LAYOUT_4x3" ? "10 × 7.5" : layout === "LAYOUT_WIDE" ? "13.33 × 7.5" : "10 × 5.625";
    return Promise.resolve(
      `Created presentation "${id}" (${layout}, ${dims} inches). Use this ID for all subsequent pptx_ calls.`,
    );
  }
}

// ── pptx_add_slide ────────────────────────────────────────────────────────────

export class PptxAddSlideTool extends BaseTool {
  readonly name = "pptx_add_slide";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Add a new slide to a presentation. Returns the 1-based slide number to use with other pptx_ tools.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string", description: "ID returned by pptx_create" },
      background_color: {
        type: "string",
        description: "Slide background hex color (e.g. 'FFFFFF' for white)",
      },
      background_image: {
        type: "string",
        description: "Path or URL for a background image",
      },
      notes: { type: "string", description: "Speaker notes for this slide" },
    },
    required: ["presentation_id"],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const { pres, slides } = getEntry(params.presentation_id as string);
    const slide = pres.addSlide();

    if (params.background_color) {
      slide.background = { fill: params.background_color as string };
    }
    if (params.background_image) {
      slide.background = { path: params.background_image as string };
    }
    if (params.notes) {
      slide.addNotes(params.notes as string);
    }

    slides.push(slide);
    return Promise.resolve(
      `Added slide ${slides.length} to presentation "${params.presentation_id as string}".`,
    );
  }
}

// ── pptx_add_text ─────────────────────────────────────────────────────────────

export class PptxAddTextTool extends BaseTool {
  readonly name = "pptx_add_text";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Add a text box to a slide. All coordinates in inches. " +
    "For 16:9 slides: slide is 10\" wide × 5.625\" tall. " +
    "Supports bold, italic, color, font size, alignment, bullets, rotation, hyperlinks. " +
    "For mixed-format runs pass text as a JSON array string: " +
    "'[{\"text\":\"bold\",\"options\":{\"bold\":true}},{\"text\":\" normal\"}]'";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string" },
      slide: { type: "number", description: "1-based slide number" },
      text: {
        type: "string",
        description: "Text content (use \\n for newlines) or JSON array string for mixed formatting",
      },
      x: { type: "number", description: "X position in inches from left" },
      y: { type: "number", description: "Y position in inches from top" },
      w: { type: "number", description: "Width in inches" },
      h: { type: "number", description: "Height in inches" },
      font_size: { type: "number", description: "Font size in points" },
      font_face: { type: "string", description: "Font family name (e.g. 'Arial')" },
      bold: { type: "boolean" },
      italic: { type: "boolean" },
      underline: { type: "boolean" },
      color: { type: "string", description: "Text hex color (e.g. '000000')" },
      align: { type: "string", enum: ["left", "center", "right", "justify"] },
      valign: { type: "string", enum: ["top", "middle", "bottom"] },
      fill_color: { type: "string", description: "Text box background hex color" },
      fill_transparency: { type: "number", description: "Background transparency 0–100" },
      line_color: { type: "string", description: "Text box border hex color" },
      line_width: { type: "number", description: "Border width in points" },
      bullet: { type: "boolean", description: "Enable bullet points" },
      bullet_type: { type: "string", enum: ["bullet", "number"], description: "Bullet style" },
      rotate: { type: "number", description: "Rotation in degrees" },
      wrap: { type: "boolean", description: "Word wrap (default true)" },
      char_spacing: { type: "number", description: "Character spacing in points" },
      line_spacing: { type: "number", description: "Line spacing multiplier" },
      hyperlink: { type: "string", description: "URL to hyperlink the entire text box" },
      shadow: { type: "boolean", description: "Add outer drop shadow" },
    },
    required: ["presentation_id", "slide", "text", "x", "y", "w", "h"],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const slide = getSlide(params.presentation_id as string, params.slide as number);

    const opts: AnyOpts = {
      x: params.x as number,
      y: params.y as number,
      w: params.w as number,
      h: params.h as number,
    };

    if (params.font_size !== undefined) opts.fontSize = params.font_size as number;
    if (params.font_face) opts.fontFace = params.font_face as string;
    if (params.bold !== undefined) opts.bold = params.bold as boolean;
    if (params.italic !== undefined) opts.italic = params.italic as boolean;
    if (params.underline !== undefined) opts.underline = { style: "sng" };
    if (params.color) opts.color = params.color as string;
    if (params.align) opts.align = params.align as string;
    if (params.valign) opts.valign = params.valign as string;
    if (params.fill_color) {
      opts.fill = {
        color: params.fill_color as string,
        ...(params.fill_transparency !== undefined
          ? { transparency: params.fill_transparency as number }
          : {}),
      };
    }
    if (params.line_color || params.line_width) {
      opts.line = {
        ...(params.line_color ? { color: params.line_color as string } : {}),
        ...(params.line_width ? { width: params.line_width as number } : {}),
      };
    }
    if (params.bullet === true) {
      opts.bullet = params.bullet_type === "number" ? { type: "number" } : true;
      opts.indentLevel = 0;
    }
    if (params.rotate !== undefined) opts.rotate = params.rotate as number;
    if (params.wrap !== undefined) opts.wrap = params.wrap as boolean;
    if (params.char_spacing !== undefined) opts.charSpacing = params.char_spacing as number;
    if (params.line_spacing !== undefined) opts.lineSpacingMultiple = params.line_spacing as number;
    if (params.hyperlink) opts.hyperlink = { url: params.hyperlink as string };
    if (params.shadow) opts.shadow = DEFAULT_SHADOW;

    // Support rich text array passed as JSON string
    const textRaw = params.text as string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let content: string | any[];
    if (textRaw.trimStart().startsWith("[")) {
      try {
        content = JSON.parse(textRaw) as AnyOpts[];
      } catch {
        content = textRaw;
      }
    } else {
      content = textRaw;
    }

    slide.addText(content, opts);
    return Promise.resolve(`Added text to slide ${params.slide as number}.`);
  }
}

// ── pptx_add_image ────────────────────────────────────────────────────────────

export class PptxAddImageTool extends BaseTool {
  readonly name = "pptx_add_image";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Add an image to a slide. Provide path (local file or URL) or data (base64 with MIME prefix). " +
    "Formats: PNG, JPG, GIF, SVG. Coordinates in inches.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string" },
      slide: { type: "number", description: "1-based slide number" },
      path: { type: "string", description: "File path or HTTP/HTTPS URL" },
      data: {
        type: "string",
        description: "Base64 with MIME prefix, e.g. 'image/png;base64,iVBOR...'",
      },
      x: { type: "number", description: "X position in inches" },
      y: { type: "number", description: "Y position in inches" },
      w: { type: "number", description: "Width in inches" },
      h: { type: "number", description: "Height in inches" },
      alt_text: { type: "string", description: "Accessibility description" },
      hyperlink: { type: "string", description: "URL to link the image to" },
      rounding: { type: "boolean", description: "Circular/rounded crop" },
      rotate: { type: "number", description: "Rotation in degrees" },
      transparency: { type: "number", description: "Transparency 0–100" },
      sizing_type: {
        type: "string",
        enum: ["contain", "cover", "crop"],
        description: "How to fit the image in its bounding box",
      },
    },
    required: ["presentation_id", "slide", "x", "y", "w", "h"],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const slide = getSlide(params.presentation_id as string, params.slide as number);

    if (!params.path && !params.data) {
      throw new Error("Either path or data is required for pptx_add_image.");
    }

    const opts: AnyOpts = {
      x: params.x as number,
      y: params.y as number,
      w: params.w as number,
      h: params.h as number,
    };

    if (params.path) opts.path = params.path as string;
    if (params.data) opts.data = params.data as string;
    if (params.alt_text) opts.altText = params.alt_text as string;
    if (params.hyperlink) opts.hyperlink = { url: params.hyperlink as string };
    if (params.rounding !== undefined) opts.rounding = params.rounding as boolean;
    if (params.rotate !== undefined) opts.rotate = params.rotate as number;
    if (params.transparency !== undefined) opts.transparency = params.transparency as number;
    if (params.sizing_type) {
      opts.sizing = {
        type: params.sizing_type as string,
        w: params.w as number,
        h: params.h as number,
      };
    }

    slide.addImage(opts);
    return Promise.resolve(`Added image to slide ${params.slide as number}.`);
  }
}

// ── pptx_add_shape ────────────────────────────────────────────────────────────

const SHAPE_HELP =
  "rect, ellipse, roundRect, triangle, diamond, line, " +
  "rightArrow, leftArrow, upArrow, downArrow, " +
  "star4, star5, star6, star8, hexagon, pentagon, plus, cloud, cube, cylinder. " +
  "Any pptxgenjs SHAPE_NAME string also accepted.";

export class PptxAddShapeTool extends BaseTool {
  readonly name = "pptx_add_shape";
  readonly tags = ["pptx", "write"] as const;
  readonly description = `Add a shape to a slide. Coordinates in inches. Shape options: ${SHAPE_HELP}`;
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string" },
      slide: { type: "number", description: "1-based slide number" },
      shape: { type: "string", description: `Shape name. Options: ${SHAPE_HELP}` },
      x: { type: "number", description: "X position in inches" },
      y: { type: "number", description: "Y position in inches" },
      w: { type: "number", description: "Width in inches" },
      h: { type: "number", description: "Height in inches" },
      fill_color: { type: "string", description: "Fill hex color (e.g. '4472C4'), or null for no fill" },
      fill_transparency: { type: "number", description: "Fill transparency 0–100" },
      line_color: { type: "string", description: "Border hex color" },
      line_width: { type: "number", description: "Border width in points" },
      line_dash: {
        type: "string",
        enum: ["solid", "dash", "dashDot", "lgDash", "lgDashDot", "sysDash", "sysDot"],
      },
      text: { type: "string", description: "Optional text rendered inside the shape" },
      font_size: { type: "number", description: "Font size for shape text (points)" },
      font_color: { type: "string", description: "Text hex color" },
      bold: { type: "boolean" },
      align: { type: "string", enum: ["left", "center", "right"] },
      rotate: { type: "number", description: "Rotation in degrees" },
      shadow: { type: "boolean", description: "Add outer drop shadow" },
      hyperlink: { type: "string", description: "URL to link shape to" },
    },
    required: ["presentation_id", "slide", "shape", "x", "y", "w", "h"],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const slide = getSlide(params.presentation_id as string, params.slide as number);
    const shapeType = resolveShape(params.shape as string);

    const fill: AnyOpts | undefined =
      params.fill_color != null
        ? {
            color: params.fill_color as string,
            ...(params.fill_transparency !== undefined
              ? { transparency: params.fill_transparency as number }
              : {}),
          }
        : undefined;

    const line: AnyOpts | undefined =
      params.line_color || params.line_width || params.line_dash
        ? {
            ...(params.line_color ? { color: params.line_color as string } : {}),
            ...(params.line_width ? { width: params.line_width as number } : {}),
            ...(params.line_dash ? { dashType: params.line_dash as string } : {}),
          }
        : undefined;

    if (params.text) {
      // Text+shape combo: use addText with shape background
      const textOpts: AnyOpts = {
        x: params.x as number,
        y: params.y as number,
        w: params.w as number,
        h: params.h as number,
        shape: shapeType,
        align: "center",
        valign: "middle",
        ...(fill ? { fill } : {}),
        ...(line ? { line } : {}),
        ...(params.font_size ? { fontSize: params.font_size as number } : {}),
        ...(params.font_color ? { color: params.font_color as string } : {}),
        ...(params.bold !== undefined ? { bold: params.bold as boolean } : {}),
        ...(params.align ? { align: params.align as string } : {}),
        ...(params.rotate !== undefined ? { rotate: params.rotate as number } : {}),
        ...(params.shadow ? { shadow: DEFAULT_SHADOW } : {}),
        ...(params.hyperlink ? { hyperlink: { url: params.hyperlink as string } } : {}),
      };
      slide.addText(params.text as string, textOpts);
    } else {
      const shapeOpts: AnyOpts = {
        x: params.x as number,
        y: params.y as number,
        w: params.w as number,
        h: params.h as number,
        ...(fill ? { fill } : {}),
        ...(line ? { line } : {}),
        ...(params.rotate !== undefined ? { rotate: params.rotate as number } : {}),
        ...(params.shadow ? { shadow: DEFAULT_SHADOW } : {}),
        ...(params.hyperlink ? { hyperlink: { url: params.hyperlink as string } } : {}),
      };
      slide.addShape(shapeType, shapeOpts);
    }

    return Promise.resolve(`Added ${params.shape as string} to slide ${params.slide as number}.`);
  }
}

// ── pptx_add_table ────────────────────────────────────────────────────────────

export class PptxAddTableTool extends BaseTool {
  readonly name = "pptx_add_table";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Add a table to a slide. Each row is an array of cell objects. " +
    "Cell fields: text (string), bold (bool), italic (bool), color (hex), fill_color (hex), " +
    "align ('left'|'center'|'right'), colspan (int), rowspan (int), font_size (num), hyperlink (url). " +
    "Coordinates in inches.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string" },
      slide: { type: "number", description: "1-based slide number" },
      rows: {
        type: "array",
        description: "2D array of row arrays containing cell objects",
        items: { type: "array", items: { type: "object" } },
      },
      x: { type: "number", description: "X position in inches" },
      y: { type: "number", description: "Y position in inches" },
      w: { type: "number", description: "Total table width in inches" },
      col_widths: {
        type: "array",
        items: { type: "number" },
        description: "Per-column widths in inches (must sum to w)",
      },
      row_height: { type: "number", description: "Uniform row height in inches" },
      font_size: { type: "number", description: "Default font size for all cells" },
      font_face: { type: "string", description: "Default font family" },
      border_color: { type: "string", description: "Border hex color (default '000000')" },
      border_width: { type: "number", description: "Border width in points (default 1)" },
      header_fill: { type: "string", description: "Background hex color for first row" },
      header_color: { type: "string", description: "Text hex color for first row" },
      header_bold: { type: "boolean", description: "Bold text in first row" },
      fill_color: { type: "string", description: "Default background for all cells" },
      align: { type: "string", enum: ["left", "center", "right"] },
      valign: { type: "string", enum: ["top", "middle", "bottom"] },
    },
    required: ["presentation_id", "slide", "rows", "x", "y", "w"],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const slide = getSlide(params.presentation_id as string, params.slide as number);

    const rawRows = params.rows as Array<Array<Record<string, unknown>>>;
    const headerFill = params.header_fill as string | undefined;
    const headerColor = params.header_color as string | undefined;
    const headerBold = params.header_bold as boolean | undefined;

    const tableRows: AnyOpts[][] = rawRows.map((row, rowIdx) =>
      row.map((cell): AnyOpts => {
        const isHeader = rowIdx === 0 && (headerFill || headerColor || headerBold);
        const cellFill =
          (cell.fill_color as string | undefined) ??
          (isHeader && headerFill ? headerFill : undefined) ??
          (params.fill_color as string | undefined);

        return {
          text: String(cell.text ?? ""),
          options: {
            ...(cell.bold !== undefined || (isHeader && headerBold)
              ? { bold: (cell.bold as boolean | undefined) ?? (headerBold as boolean | undefined) }
              : {}),
            ...(cell.italic !== undefined ? { italic: cell.italic as boolean } : {}),
            ...((cell.color as string | undefined) || (isHeader && headerColor)
              ? { color: (cell.color as string | undefined) ?? headerColor }
              : {}),
            ...(cellFill ? { fill: { color: cellFill } } : {}),
            ...(cell.align
              ? { align: cell.align as string }
              : params.align
              ? { align: params.align as string }
              : {}),
            ...(cell.font_size
              ? { fontSize: cell.font_size as number }
              : params.font_size
              ? { fontSize: params.font_size as number }
              : {}),
            ...(params.font_face ? { fontFace: params.font_face as string } : {}),
            ...(cell.colspan ? { colspan: cell.colspan as number } : {}),
            ...(cell.rowspan ? { rowspan: cell.rowspan as number } : {}),
            ...(cell.hyperlink ? { hyperlink: { url: cell.hyperlink as string } } : {}),
          },
        };
      }),
    );

    const tableOpts: AnyOpts = {
      x: params.x as number,
      y: params.y as number,
      w: params.w as number,
      border: {
        pt: (params.border_width as number | undefined) ?? 1,
        color: (params.border_color as string | undefined) ?? "000000",
      },
      ...(params.col_widths ? { colW: params.col_widths as number[] } : {}),
      ...(params.row_height ? { rowH: params.row_height as number } : {}),
      ...(params.valign ? { valign: params.valign as string } : {}),
    };

    slide.addTable(tableRows, tableOpts);
    return Promise.resolve(`Added table (${rawRows.length} rows) to slide ${params.slide as number}.`);
  }
}

// ── pptx_add_chart ────────────────────────────────────────────────────────────

export class PptxAddChartTool extends BaseTool {
  readonly name = "pptx_add_chart";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Add a chart to a slide. " +
    "chart_type: bar, line, pie, area, doughnut, scatter, radar, bubble. " +
    "For vertical column bars use bar with bar_dir='col'. " +
    "Each data series: { name, labels, values }. Coordinates in inches.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string" },
      slide: { type: "number", description: "1-based slide number" },
      chart_type: {
        type: "string",
        enum: ["bar", "line", "pie", "area", "doughnut", "scatter", "radar", "bubble"],
      },
      data: {
        type: "array",
        description: "Series: [{ name, labels: string[], values: number[] }]",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            labels: { type: "array", items: { type: "string" } },
            values: { type: "array", items: { type: "number" } },
          },
          required: ["name", "labels", "values"],
        },
      },
      x: { type: "number", description: "X position in inches" },
      y: { type: "number", description: "Y position in inches" },
      w: { type: "number", description: "Width in inches" },
      h: { type: "number", description: "Height in inches" },
      title: { type: "string", description: "Chart title text" },
      bar_dir: {
        type: "string",
        enum: ["bar", "col"],
        description: "Bar direction: bar=horizontal, col=vertical (default col)",
      },
      show_legend: { type: "boolean", description: "Show chart legend (default true)" },
      legend_position: {
        type: "string",
        enum: ["r", "l", "t", "b"],
        description: "Legend position: r=right, l=left, t=top, b=bottom",
      },
      show_data_labels: { type: "boolean", description: "Show values on bars/segments" },
      colors: {
        type: "array",
        items: { type: "string" },
        description: "Series hex colors, e.g. ['4472C4', 'ED7D31']",
      },
      val_axis_min: { type: "number", description: "Value axis minimum" },
      val_axis_max: { type: "number", description: "Value axis maximum" },
    },
    required: ["presentation_id", "slide", "chart_type", "data", "x", "y", "w", "h"],
  };

  run(params: Record<string, unknown>, _ctx: ToolContext): Promise<ToolExecutorResult> {
    const slide = getSlide(params.presentation_id as string, params.slide as number);

    const chartType: string =
      CHART_ALIASES[params.chart_type as string] ?? (params.chart_type as string);

    const chartData = params.data as Array<{
      name: string;
      labels: string[];
      values: number[];
    }>;

    const chartOpts: AnyOpts = {
      x: params.x as number,
      y: params.y as number,
      w: params.w as number,
      h: params.h as number,
      barDir: ((params.bar_dir as string | undefined) ?? "col"),
    };

    if (params.title) chartOpts.title = params.title as string;

    if (params.show_legend === false) {
      chartOpts.showLegend = false;
    } else {
      chartOpts.showLegend = true;
      chartOpts.legendPos = (params.legend_position as string | undefined) ?? "r";
    }

    if (params.show_data_labels) chartOpts.showLabel = true;
    if (params.colors) chartOpts.chartColors = params.colors as string[];
    if (params.val_axis_min !== undefined) chartOpts.valAxisMinVal = params.val_axis_min as number;
    if (params.val_axis_max !== undefined) chartOpts.valAxisMaxVal = params.val_axis_max as number;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    slide.addChart(chartType as any, chartData, chartOpts);
    return Promise.resolve(`Added ${params.chart_type as string} chart to slide ${params.slide as number}.`);
  }
}

// ── pptx_save ─────────────────────────────────────────────────────────────────

export class PptxSaveTool extends BaseTool {
  readonly name = "pptx_save";
  readonly tags = ["pptx", "write"] as const;
  readonly description =
    "Save a presentation to a .pptx file and free it from memory. " +
    "Pass an absolute path or relative path (resolved from cwd). " +
    "The .pptx extension is added automatically if omitted.";
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      presentation_id: { type: "string", description: "ID returned by pptx_create" },
      output_path: {
        type: "string",
        description: "Output file path (e.g. '/tmp/report.pptx' or 'report')",
      },
    },
    required: ["presentation_id", "output_path"],
  };

  async run(params: Record<string, unknown>, ctx: ToolContext): Promise<ToolExecutorResult> {
    const { pres } = getEntry(params.presentation_id as string);
    let outPath = params.output_path as string;

    if (!outPath.startsWith("/")) outPath = `${ctx.cwd}/${outPath}`;
    if (!outPath.endsWith(".pptx")) outPath += ".pptx";

    await pres.writeFile({ fileName: outPath });

    _store.delete(params.presentation_id as string);

    return `Saved presentation to: ${outPath}`;
  }
}

// ── Bundle ────────────────────────────────────────────────────────────────────

/** All pptx tools — register with your ToolRegistry to enable presentation creation. */
export const PPTX_TOOLS = [
  new PptxCreateTool(),
  new PptxAddSlideTool(),
  new PptxAddTextTool(),
  new PptxAddImageTool(),
  new PptxAddShapeTool(),
  new PptxAddTableTool(),
  new PptxAddChartTool(),
  new PptxSaveTool(),
] as const;

import type { ToolGroup } from "./groups.js";

/** Lazy-loadable tool group for PowerPoint generation. */
export const pptxGroup: ToolGroup = {
  name: "pptx",
  description: "Build .pptx presentations slide-by-slide (text, images, shapes, tables, charts)",
  toolNames: [
    "pptx_create",
    "pptx_add_slide",
    "pptx_add_text",
    "pptx_add_image",
    "pptx_add_shape",
    "pptx_add_table",
    "pptx_add_chart",
    "pptx_save",
  ],
  guidance: [
    "Build a .pptx in this order:",
    "  1. pptx_create — start a new deck (handle returned).",
    "  2. pptx_add_slide — add a slide, get a slide id.",
    "  3. pptx_add_text / pptx_add_image / pptx_add_shape / pptx_add_table / pptx_add_chart —",
    "     populate the slide. Coordinates are in inches; default 13.333×7.5 (16:9).",
    "  4. pptx_save — write the file to disk.",
    "",
    "Prefer html_to_pdf for read-only documents; use pptx only when the user explicitly",
    "wants an editable .pptx. Add slides one at a time and verify with the returned",
    "thumbnails / sizes before piling on more.",
  ].join("\n"),
};
