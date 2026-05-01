/**
 * Lightweight skin engine. Inspired by hermes_cli/skin_engine.py but scoped
 * to what squad actually uses today: a named color palette plus branding
 * strings. User skins live at `~/.squad/skins/<name>.json`. The active skin
 * is persisted to `~/.squad/skin`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Skin {
  name: string;
  description: string;
  colors: Record<string, string>;
  branding: Record<string, string>;
}

const BUILTIN: Record<string, Skin> = {
  default: {
    name: "default",
    description: "Squad — electric blue and amber on black",
    colors: {
      brand: "#5EE1FF",
      brand_dim: "#2A8FB0",
      accent: "#FFB84D",
      accent_dim: "#B87A1A",
      text: "#E8E8E8",
      muted: "#8A8A8A",
      border: "#3A4B5C",
      ok: "#7FD184",
      warn: "#FFB84D",
      err: "#FF7B7B",
      prompt: "#5EE1FF",
      status_bg: "#0F1B26",
      status_text: "#C0C0C0",
      status_strong: "#FFD27F",
      question_border: "#FFB84D",
    },
    branding: {
      agent_name: "Squad",
      user_name: "you",
      welcome: "Welcome to Squad. Type a message or /help for commands.",
      goodbye: "see you later.",
      prompt_symbol: "▸",
      help_header: "Commands",
    },
  },
  mono: {
    name: "mono",
    description: "Grayscale. No colors, just weight.",
    colors: {
      brand: "#FFFFFF",
      brand_dim: "#888888",
      accent: "#DDDDDD",
      accent_dim: "#777777",
      text: "#E8E8E8",
      muted: "#888888",
      border: "#555555",
      ok: "#DDDDDD",
      warn: "#FFFFFF",
      err: "#FFFFFF",
      prompt: "#FFFFFF",
      status_bg: "#1a1a1a",
      status_text: "#C0C0C0",
      status_strong: "#FFFFFF",
      question_border: "#AAAAAA",
    },
    branding: {
      agent_name: "Squad",
      user_name: "you",
      welcome: "squad ready.",
      goodbye: "bye.",
      prompt_symbol: ">",
      help_header: "commands",
    },
  },
  slate: {
    name: "slate",
    description: "Cool blues for long focus sessions",
    colors: {
      brand: "#7FB3D5",
      brand_dim: "#4A7899",
      accent: "#A9DFBF",
      accent_dim: "#5E8B74",
      text: "#ECF0F1",
      muted: "#7F8C8D",
      border: "#34495E",
      ok: "#2ECC71",
      warn: "#F39C12",
      err: "#E74C3C",
      prompt: "#7FB3D5",
      status_bg: "#17202A",
      status_text: "#AAB7B8",
      status_strong: "#A9DFBF",
      question_border: "#7FB3D5",
    },
    branding: {
      agent_name: "Squad",
      user_name: "you",
      welcome: "Squad — ready.",
      goodbye: "later.",
      prompt_symbol: "›",
      help_header: "Commands",
    },
  },
  poseidon: {
    name: "poseidon",
    description: "Deep sea — teal and coral",
    colors: {
      brand: "#00C7B7",
      brand_dim: "#007A70",
      accent: "#FF6B6B",
      accent_dim: "#8B3A3A",
      text: "#E8F6F4",
      muted: "#7FA39F",
      border: "#1F4E4A",
      ok: "#3DDC97",
      warn: "#FFD166",
      err: "#FF6B6B",
      prompt: "#00C7B7",
      status_bg: "#082025",
      status_text: "#BCE1DC",
      status_strong: "#FF6B6B",
      question_border: "#00C7B7",
    },
    branding: {
      agent_name: "Squad",
      user_name: "you",
      welcome: "Squad rises from the depths.",
      goodbye: "fair winds.",
      prompt_symbol: "≈",
      help_header: "Commands",
    },
  },
  ares: {
    name: "ares",
    description: "War-god red. Loud and unapologetic.",
    colors: {
      brand: "#E74C3C",
      brand_dim: "#922B21",
      accent: "#F1C40F",
      accent_dim: "#7D6608",
      text: "#FDFEFE",
      muted: "#808B96",
      border: "#641E16",
      ok: "#58D68D",
      warn: "#F1C40F",
      err: "#E74C3C",
      prompt: "#E74C3C",
      status_bg: "#1B0D0A",
      status_text: "#E5E7E9",
      status_strong: "#F1C40F",
      question_border: "#E74C3C",
    },
    branding: {
      agent_name: "Squad",
      user_name: "you",
      welcome: "Squad. Attack.",
      goodbye: "retreat.",
      prompt_symbol: "⚔",
      help_header: "Commands",
    },
  },
};

const STATE_PATH = join(homedir(), ".squad", "skin");
const USER_SKIN_DIR = join(homedir(), ".squad", "skins");

let cached: Skin | null = null;

function readUserSkin(name: string): Skin | null {
  const path = join(USER_SKIN_DIR, `${name}.json`);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Skin>;
    if (!raw.name) return null;
    return {
      name: raw.name,
      description: raw.description ?? "",
      colors: { ...BUILTIN.default!.colors, ...(raw.colors ?? {}) },
      branding: { ...BUILTIN.default!.branding, ...(raw.branding ?? {}) },
    };
  } catch {
    return null;
  }
}

function readActiveName(): string {
  if (process.env.SQUAD_SKIN) return process.env.SQUAD_SKIN;
  if (!existsSync(STATE_PATH)) return "default";
  try {
    return readFileSync(STATE_PATH, "utf8").trim() || "default";
  } catch {
    return "default";
  }
}

export function getActiveSkin(): Skin {
  if (cached) return cached;
  const name = readActiveName();
  const skin = BUILTIN[name] ?? readUserSkin(name) ?? BUILTIN.default!;
  cached = skin;
  return skin;
}

export function setActiveSkin(name: string): Skin {
  const skin = BUILTIN[name] ?? readUserSkin(name);
  if (!skin) {
    throw new Error(`unknown skin: ${name}. Try /skin list.`);
  }
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, name + "\n");
  cached = skin;
  return skin;
}

export function listSkins(): Skin[] {
  const out: Skin[] = Object.values(BUILTIN);
  if (existsSync(USER_SKIN_DIR)) {
    for (const f of readdirSync(USER_SKIN_DIR)) {
      if (!f.endsWith(".json")) continue;
      const s = readUserSkin(f.replace(/\.json$/, ""));
      if (s && !out.some((x) => x.name === s.name)) out.push(s);
    }
  }
  return out;
}

/** Convenience: hex value for a color role on the active skin. */
export function roleColor(role: string, fallback = "#E8E8E8"): string {
  return getActiveSkin().colors[role] ?? fallback;
}

/**
 * Runtime branding overrides — populated from the gateway's
 * `admin.identity.branding` after connect, so the CLI shows the same labels
 * as the dashboard without forcing the user to mirror them in their skin.
 * Overrides win over the active skin's `branding` map; falling back to the
 * skin keeps the CLI usable when the gateway is unreachable or older.
 */
const brandingOverrides: Record<string, string> = {};

export function setBrandingOverrides(overrides: Record<string, string>): void {
  for (const [k, v] of Object.entries(overrides)) {
    if (typeof v === "string" && v.length > 0) brandingOverrides[k] = v;
  }
}

export function brandString(role: string, fallback = ""): string {
  return brandingOverrides[role] ?? getActiveSkin().branding[role] ?? fallback;
}
