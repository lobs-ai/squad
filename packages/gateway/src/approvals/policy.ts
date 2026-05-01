import type { ApprovalPolicy } from "@squad/plugin-sdk";

export interface TagMatchOptions {
  /**
   * Tags that require approval. Any tool carrying one of these tags
   * escalates. Pass a function to read the current value on every decision —
   * required when the underlying config can change at runtime, otherwise
   * edits via `set_config` / `admin.config.set` won't take effect until the
   * gateway restarts.
   */
  requireForTags: string[] | (() => string[]);
  /**
   * Specific tool names that require approval regardless of tags. Same
   * function-vs-static semantics as `requireForTags`. Defaults to an empty
   * list when omitted.
   */
  requireForTools?: string[] | (() => string[]);
}

function asReader(v: string[] | (() => string[]) | undefined): () => string[] {
  if (v === undefined) return () => [];
  return typeof v === "function" ? v : () => v;
}

export function tagMatchPolicy(options: TagMatchOptions): ApprovalPolicy {
  const readTags = asReader(options.requireForTags);
  const readTools = asReader(options.requireForTools);
  return {
    async decide(ctx): Promise<"approve" | "deny" | "escalate"> {
      const tagSet = new Set(readTags());
      if (ctx.tags.some((t) => tagSet.has(t))) return "escalate";
      const toolSet = new Set(readTools());
      if (toolSet.has(ctx.toolName)) return "escalate";
      return "approve";
    },
  };
}

export const allowAllPolicy: ApprovalPolicy = {
  async decide() {
    return "approve";
  },
};

export const denyAllPolicy: ApprovalPolicy = {
  async decide() {
    return "deny";
  },
};

/**
 * Cascade the provided policies: the first one to return a non-"escalate"
 * verdict wins. Returns "escalate" if every policy defers.
 */
export function cascade(policies: ApprovalPolicy[]): ApprovalPolicy {
  return {
    async decide(ctx) {
      for (const p of policies) {
        const verdict = await p.decide(ctx);
        if (verdict !== "escalate") return verdict;
      }
      return "escalate";
    },
  };
}
