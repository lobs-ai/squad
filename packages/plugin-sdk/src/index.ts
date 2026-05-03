export * from "./types.js";
export * from "./manifest.js";
export * from "./errors.js";
export * from "./config-schema.js";

// Re-export the canonical prompt-slot taxonomy so plugins can name slots
// from a single import (`import { PROMPT_SLOTS } from "@squad/plugin-sdk"`).
export { PROMPT_SLOTS } from "@squad/tools";
export type { PromptSlot, PromptContextSnapshot, RenderContext } from "@squad/tools";
