export * from "./types.js";
export * from "./client.js";
export { AnthropicClient } from "./providers/anthropic.js";
export { OpenAIClient } from "./providers/openai.js";
export { ClaudeCliClient } from "./providers/claude-cli.js";
export type { ClaudeCliClientOptions } from "./providers/claude-cli.js";
export {
  buildCompatibleClient,
  stripOpenRouterPrefix,
  KNOWN_ENDPOINTS,
} from "./providers/openai-compatible.js";
export {
  createModelChain,
  type ModelChain,
  type ModelChainConfig,
} from "./chain.js";
export {
  classifyError,
  type ClassifiedError,
  type LLMErrorType,
} from "./errors.js";
export {
  MODEL_CATALOG,
  listAvailableModels,
  augmentWithExtras,
  allModels,
  type ModelInfo,
} from "./catalog.js";
