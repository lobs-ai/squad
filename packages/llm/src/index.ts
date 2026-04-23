export * from "./types.js";
export * from "./client.js";
export { AnthropicClient } from "./providers/anthropic.js";
export { OpenAIClient } from "./providers/openai.js";
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
  allModels,
  type ModelInfo,
} from "./catalog.js";
