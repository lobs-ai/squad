// Narrow re-export surface: collide-free names for the tool's backend types,
// and the tool classes / registration helper.
export type {
  TaskBackend,
  Task as TaskBackendTask,
  TaskStatus as TaskBackendStatus,
} from "./backend.js";
export {
  CreateTaskTool,
  UpdateTaskTool,
  ListTasksTool,
  GetTaskTool,
  registerTaskTools,
} from "./tools.js";
export { TASK_GUIDANCE } from "./prompt.js";

import type { ToolGroup } from "../groups.js";
import { TASK_GUIDANCE } from "./prompt.js";

/** Lazy-loadable tool group for shared task list. */
export const tasksGroup: ToolGroup = {
  name: "tasks",
  description:
    "Shared task list scoped to the session tree — plan, track, and hand off multi-step work",
  toolNames: ["create_task", "update_task", "list_tasks", "get_task"],
  guidance: TASK_GUIDANCE,
};
