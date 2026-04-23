import type { ApprovalPolicy } from "@squad/plugin-sdk";

export interface TagMatchOptions {
  requireForTags: string[];
}

/**
 * Default policy: any tool whose tags intersect `requireForTags` prompts for
 * approval (returns "escalate"). Everything else auto-approves.
 */
export function tagMatchPolicy(options: TagMatchOptions): ApprovalPolicy {
  const requireSet = new Set(options.requireForTags);
  return {
    async decide(ctx): Promise<"approve" | "deny" | "escalate"> {
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
