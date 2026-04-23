// Re-export surface kept narrow on purpose. The gateway uses @squad/protocol
// types at the wire layer; this package only exposes the tool itself and the
// backend interface it delegates to.
export type {
  AskOption as AskUserOption,
  AskQuestion as AskUserQuestion,
  AskInput as AskUserInput,
  AskResult as AskUserResult,
  QuestionBackend,
} from "./backend.js";
export { AskUserTool, registerAskUserTool } from "./tools.js";
export { ASK_GUIDANCE } from "./prompt.js";
