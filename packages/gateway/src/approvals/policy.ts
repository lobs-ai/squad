import type { ApprovalPolicy } from "@squad/plugin-sdk";

export interface TagMatchOptions {
  /**
   * Tags that require approval. Pass a function to read the current value on
   * every decision — required when the underlying config can change at
   * runtime, otherwise edits via `set_config` / `admin.config.set` won't take
   * effect until the gateway restarts.
   */
  requireForTags: string[] | (() => string[]);
}

export function tagMatchPolicy(options: TagMatchOptions): ApprovalPolicy {
  const read =
    typeof options.requireForTags === "function"
      ? options.requireForTags
      : () => options.requireForTags as string[];
  return {
    async decide(ctx): Promise<"approve" | "deny" | "escalate"> {
      const requireSet = new Set(read());
      const hit = ctx.tags.some((t) => requireSet.has(t));
      return hit ? "escalate" : "approve";
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
