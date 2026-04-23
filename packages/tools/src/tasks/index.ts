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
