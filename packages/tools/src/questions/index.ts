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

import type { ToolGroup } from "../groups.js";
import { ASK_GUIDANCE } from "./prompt.js";

/**
 * Default tool group for ask_user. Loaded on every turn — channels render
 * structured questions natively (channel-specific buttons, CLI select, etc.)
 * so this is cheap to keep resident.
 */
export const questionsGroup: ToolGroup = {
  name: "questions",
  description: "Pose a structured multiple-choice question to the user (ask_user)",
  toolNames: ["ask_user"],
  guidance: ASK_GUIDANCE,
  default: true,
};
