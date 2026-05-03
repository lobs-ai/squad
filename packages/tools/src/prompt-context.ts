/**
 * PromptContext + RenderContext + PromptFragment.
 *
 * Tools render their description (and other prompt sections) against a live
 * snapshot of "what's loaded" (PromptContext) plus a per-turn snapshot of
 * "where we are right now" (RenderContext). Plugins contribute fragments —
 * short hints attached to a named slot — that tools render conditionally.
 *
 * The store is a plain mutable object owned by the gateway; mutations bump
 * `version` and notify subscribers so callers (the runner, the registry) can
 * rebuild dependent prompts without restarting.
 *
 * RenderContext flows per-turn through AsyncLocalStorage so tool descriptions
 * read it without an explicit threading parameter.
 */
import { AsyncLocalStorage } from "node:async_hooks";

// ── Channel + delivery + plugin types ────────────────────────────────────────

/** Capability hints; mirrors @squad/protocol ChannelCapabilities. */
export interface ChannelCapabilities {
  supportsPreview: boolean;
  supportsMultiSelect: boolean;
  supportsFreeText: boolean;
  maxOptions: number;
  supportsImages?: boolean;
  supportsFileUploads?: boolean;
  supportsTaskList?: boolean;
  supportsApprovals?: boolean;
}

export interface ChannelInfo {
  id: string;
  kind: string;
  label: string;
  connected: boolean;
  capabilities?: ChannelCapabilities;
}

/**
 * Renamed from PromptContextDeliveryKind to avoid clashing with cron/backend.ts's
 * interface of the same name (which also carries an `extrasSchema`). The
 * PromptContext only needs the lightweight shape.
 */
export interface PromptContextDeliveryKind {
  kind: string;
  builtIn: boolean;
  description?: string;
}

export interface PluginInfo {
  id: string;
  name?: string;
  version?: string;
  kinds: string[];
  enabled: boolean;
}

export interface SkillInfo {
  name: string;
  description?: string;
}

export interface ToolsetInfo {
  name: string;
  description: string;
}

// ── Render context (per-turn) ────────────────────────────────────────────────

export type RenderSurface =
  | "dashboard"
  | "cli"
  | "channel"
  | "cron-isolated"
  | "subagent"
  | "unknown";

export interface RenderContext {
  surface: RenderSurface;
  /** When surface === "channel": the channel kind (e.g. "discord", "slack"). */
  channelKind?: string;
  /** When surface === "channel": the bound channel record id. */
  channelId?: string;
  /** When surface === "channel": that channel's capabilities. */
  capabilities?: ChannelCapabilities;
  /** Set when this turn is running inside a subagent (the subagent's name). */
  parentSubagent?: string;
}

export const DEFAULT_RENDER: RenderContext = { surface: "unknown" };

// ── Fragments ────────────────────────────────────────────────────────────────

/**
 * Optional predicate evaluated at render time. When it returns false the
 * fragment is not included. Use for "this hint only matters when we're
 * delivering into Discord" gating.
 */
export type FragmentPredicate = (
  render: RenderContext,
  ctx: PromptContextSnapshot,
) => boolean;

/**
 * A named extension fragment registered by a plugin. The slot is the
 * extension point a tool renders; content is plain text spliced into the
 * tool's description (or other prompt section). When `when` is omitted the
 * fragment is always active.
 */
export interface PromptFragment {
  slot: string;
  content: string;
  /** Plugin id that owns this fragment — used by removeFragmentsForPlugin. */
  pluginId?: string;
  when?: FragmentPredicate;
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * A frozen view of PromptContext at a particular version. Tools rendering a
 * description read from this. Mutations create a new snapshot (the store
 * holds the latest) so memoization against `version` is safe.
 */
export interface PromptContextSnapshot {
  channels: ChannelInfo[];
  deliveryKinds: PromptContextDeliveryKind[];
  plugins: PluginInfo[];
  skills: SkillInfo[];
  toolsets: ToolsetInfo[];
  fragments: PromptFragment[];
  /** Free-form warnings from boot/runtime that belong in `system.startup-warnings`. */
  startupWarnings: string[];
  version: number;
}

const EMPTY_SNAPSHOT: PromptContextSnapshot = {
  channels: [],
  deliveryKinds: [],
  plugins: [],
  skills: [],
  toolsets: [],
  fragments: [],
  startupWarnings: [],
  version: 0,
};

// ── Store ────────────────────────────────────────────────────────────────────

const renderStorage = new AsyncLocalStorage<RenderContext>();

/**
 * Read the RenderContext for the currently-running turn. Defaults to
 * DEFAULT_RENDER when called outside a turn (e.g. boot, tests).
 */
export function currentRender(): RenderContext {
  return renderStorage.getStore() ?? DEFAULT_RENDER;
}

/**
 * Mutable holder for the live PromptContext snapshot. The gateway constructs
 * one per process; tools and prompt builders read from it via `get()` and
 * `fragmentsFor(slot)`.
 *
 * The store is intentionally simple:
 *   - mutators replace the whole snapshot and bump `version`
 *   - `subscribe()` lets the runner clear cached tool definitions on changes
 *   - `runWithRender()` scopes a RenderContext over a function call (used by
 *     the gateway dispatch layer to thread surface info into a turn)
 */
export class PromptContextStore {
  private snapshot: PromptContextSnapshot = EMPTY_SNAPSHOT;
  private listeners: Array<(snap: PromptContextSnapshot) => void> = [];

  get(): PromptContextSnapshot {
    return this.snapshot;
  }

  setChannels(channels: ChannelInfo[]): void {
    this.bump({ channels });
  }
  setDeliveryKinds(kinds: PromptContextDeliveryKind[]): void {
    this.bump({ deliveryKinds: kinds });
  }
  setPlugins(plugins: PluginInfo[]): void {
    this.bump({ plugins });
  }
  setSkills(skills: SkillInfo[]): void {
    this.bump({ skills });
  }
  setToolsets(toolsets: ToolsetInfo[]): void {
    this.bump({ toolsets });
  }
  setStartupWarnings(warns: string[]): void {
    this.bump({ startupWarnings: warns });
  }

  /** Replace the whole fragment list. Used by the plugin host on rebuild. */
  setFragments(fragments: PromptFragment[]): void {
    this.bump({ fragments });
  }

  /** Append fragments. */
  addFragments(fragments: PromptFragment[]): void {
    this.bump({ fragments: [...this.snapshot.fragments, ...fragments] });
  }

  /** Remove every fragment owned by a given plugin id. */
  removeFragmentsForPlugin(pluginId: string): void {
    const next = this.snapshot.fragments.filter((f) => f.pluginId !== pluginId);
    if (next.length === this.snapshot.fragments.length) return;
    this.bump({ fragments: next });
  }

  /**
   * Active fragments for a slot, filtered by each fragment's `when` predicate
   * against the current render context. Render context defaults to
   * AsyncLocalStorage's current value; pass explicitly for tests.
   */
  fragmentsFor(slot: string, render: RenderContext = currentRender()): string[] {
    return this.snapshot.fragments
      .filter((f) => f.slot === slot)
      .filter((f) => !f.when || safePredicate(f.when, render, this.snapshot))
      .map((f) => f.content);
  }

  /**
   * Run `fn` with `render` set as the current RenderContext. BaseTool
   * descriptions and any code calling `currentRender()` inside the call see
   * this value.
   */
  runWithRender<T>(render: RenderContext, fn: () => T): T {
    return renderStorage.run(render, fn);
  }

  subscribe(fn: (snap: PromptContextSnapshot) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Manually bump the version + notify (e.g. when an external state changed). */
  refresh(): void {
    this.bump({});
  }

  private bump(patch: Partial<PromptContextSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      version: this.snapshot.version + 1,
    };
    for (const l of this.listeners) {
      try {
        l(this.snapshot);
      } catch {
        // listener errors must never crash a mutation
      }
    }
  }
}

function safePredicate(
  pred: FragmentPredicate,
  render: RenderContext,
  snap: PromptContextSnapshot,
): boolean {
  try {
    return pred(render, snap);
  } catch {
    return false;
  }
}

// ── Helpers used by tool prompt renderers ────────────────────────────────────

/**
 * Render a list of fragment strings as a bulleted block, prefixed by a header.
 * Returns "" when there are no fragments — callers can append unconditionally.
 */
export function renderFragmentsBlock(header: string, fragments: string[]): string {
  if (fragments.length === 0) return "";
  const lines = [header];
  for (const f of fragments) {
    lines.push(`  - ${f.replace(/\n/g, "\n    ")}`);
  }
  return lines.join("\n");
}
