// Vendored from lobs/agentic at 7daf6dfde0ac105d19d48908f38abd64817d3782
// Original path: packages/tools/src/base-tool.ts
// Last synced: 2026-04-23

/**
 * BaseTool — abstract base class for all tools.
 *
 * Extend this class to create a tool. Override `name`, `description`,
 * `inputSchema`, and `run()`. The `definition` and `toEntry()` members
 * are derived automatically.
 *
 * Tools can opt into dynamic descriptions by implementing
 * {@link BaseTool.describe} and assigning a {@link PromptContextStore} via
 * {@link BaseTool.setPromptContextStore}. When both are set, `definition`
 * renders fresh on every read — the gateway's per-turn RenderContext flows
 * through AsyncLocalStorage so the description reflects the current channel
 * and which plugins are loaded.
 *
 * @example
 * ```ts
 * class MyTool extends BaseTool {
 *   name = "my_tool";
 *   description = "Does something useful.";
 *   inputSchema = {
 *     type: "object" as const,
 *     properties: { value: { type: "string" } },
 *     required: ["value"],
 *   };
 *   async run({ value }: { value: string }, ctx: ToolContext) {
 *     return `got: ${value} in ${ctx.cwd}`;
 *   }
 * }
 *
 * registry.register(new MyTool());
 * ```
 */

import type { ToolDefinition, ToolEntry, ToolExecutorResult } from "./types.js";
import type {
  PromptContextSnapshot,
  PromptContextStore,
  RenderContext,
} from "./prompt-context.js";
import { currentRender } from "./prompt-context.js";

/** Context passed to every tool invocation. */
export interface ToolContext {
  /** The working directory of the agent at call time. */
  cwd: string;
  /**
   * Arbitrary metadata from the calling agent — e.g. userId, sessionId,
   * channelId, or any application-specific context the tool needs.
   *
   * Populated from `AgentSpec.context` when running through `AgenticRuntime`.
   *
   * @example
   * ```ts
   * run(input, ctx) {
   *   const userId = ctx.meta?.userId as string;
   *   const sessionId = ctx.meta?.sessionId as string;
   * }
   * ```
   */
  meta?: Record<string, unknown>;
  /**
   * Secrets to inject into subprocess environments.
   * Keys are env var names; values are the resolved secret strings.
   *
   * Used by ExecTool to forward credentials (e.g. GH_TOKEN) without
   * exposing them in the tool's `params.env` input visible to the LLM.
   *
   * Populated from `meta.secrets` when routing through `toEntry()`, or
   * set directly on the context by the caller.
   *
   * @example
   * ```ts
   * registry.execute("exec", { cmd: "gh pr list" }, cwd, {
   *   secrets: { GH_TOKEN: process.env.GH_TOKEN },
   * });
   * ```
   */
  secrets?: Record<string, string>;
}

/** Input schema — JSON Schema object descriptor for the tool's input. */
export interface ToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export abstract class BaseTool<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Tool name — must be unique within a registry. */
  abstract readonly name: string;
  /**
   * Human-readable description shown to the LLM. Used as the static fallback
   * when {@link describe} is not implemented. Subclasses with dynamic prompts
   * usually set this to a short summary and override `describe`.
   */
  abstract readonly description: string;
  /** JSON Schema for the tool's input parameters. */
  abstract readonly inputSchema: ToolInputSchema;
  /**
   * Optional semantic tags for runtime tool selection.
   * Used by `ContextEngine.selectTools` and `registry.tagged()`.
   * Not sent to the LLM.
   *
   * @example `["filesystem", "readonly"]`
   */
  readonly tags?: readonly string[];

  /**
   * Live PromptContext store. Set by callers (via constructor injection or
   * {@link setPromptContextStore}) to enable dynamic descriptions. When unset,
   * `definition` falls back to the static `description` field.
   */
  protected promptContextStore?: PromptContextStore;

  /**
   * Optional dynamic description. Implemented by subclasses that vary their
   * prompt with `PromptContext` (loaded plugins) or `RenderContext` (where
   * this turn is rendering). Returning `null` falls back to `description`.
   */
  describe?(ctx: PromptContextSnapshot, render: RenderContext): string | null;

  /** Execute the tool. Errors should be thrown — the registry catches them. */
  abstract run(input: TInput, context: ToolContext): Promise<ToolExecutorResult>;

  /**
   * Inject the live prompt-context store. The gateway calls this for every
   * tool registered into its ToolRegistry after building the store.
   */
  setPromptContextStore(store: PromptContextStore): void {
    this.promptContextStore = store;
  }

  /**
   * Render the description against the live PromptContext + per-turn
   * RenderContext. Falls back to the static `description` when no store is
   * attached or `describe` is not implemented or returns null.
   */
  protected renderDescription(): string {
    if (this.describe && this.promptContextStore) {
      const out = this.describe(this.promptContextStore.get(), currentRender());
      if (out !== null) return out;
    }
    return this.description;
  }

  /** Full `ToolDefinition` derived from name / description / inputSchema / tags. */
  get definition(): ToolDefinition {
    const def: ToolDefinition = {
      name: this.name,
      description: this.renderDescription(),
      input_schema: this.inputSchema,
    };
    if (this.tags) def.tags = this.tags;
    return def;
  }

  /**
   * Convert to a `ToolEntry` for use with `ToolRegistry` or legacy registries.
   *
   * The `definition` slot is a getter so the registry sees a fresh
   * description on every read — required for live re-rendering on plugin
   * load/unload and per-turn RenderContext changes.
   */
  toEntry(): ToolEntry {
    const self = this;
    return {
      get definition() {
        return self.definition;
      },
      executor: (params: Record<string, unknown>, cwd: string, meta?: Record<string, unknown>) => {
        const secrets = meta?.secrets as Record<string, string> | undefined;
        return self.run(params as TInput, { cwd, meta, secrets });
      },
    };
  }
}
