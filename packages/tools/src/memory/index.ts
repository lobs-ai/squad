export type {
  MemoryBackend,
  MemoryEntry as MemoryBackendEntry,
  MemoryType as MemoryBackendType,
  MemoryScope as MemoryBackendScope,
  MemoryStatus as MemoryBackendStatus,
  MemoryProposeInput as MemoryBackendProposeInput,
  MemoryUpdateInput as MemoryBackendUpdateInput,
  MemoryArchiveInput as MemoryBackendArchiveInput,
  MemorySearchInput as MemoryBackendSearchInput,
  MemorySearchHit as MemoryBackendSearchHit,
  MemoryListInput as MemoryBackendListInput,
} from "./backend.js";

export {
  MemoryProposeTool,
  MemoryUpdateTool,
  MemoryArchiveTool,
  MemorySearchTool,
  MemoryListTool,
  registerMemoryTools,
} from "./tools.js";

export { MEMORY_GUIDANCE } from "./prompt.js";

import type { ToolGroup } from "../groups.js";
import { MEMORY_GUIDANCE } from "./prompt.js";

/** Lazy-loadable tool group for typed persistent memory. */
export const memoryGroup: ToolGroup = {
  name: "memory",
  description:
    "Typed, retrievable memory store (user/feedback/project/reference/working) with FTS search",
  toolNames: [
    "memory_propose",
    "memory_update",
    "memory_archive",
    "memory_search",
    "memory_list",
  ],
  guidance: MEMORY_GUIDANCE,
};
