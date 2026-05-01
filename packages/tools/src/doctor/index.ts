export type {
  DoctorBackend,
  DoctorDiagnosis,
  DoctorFixOutcome,
  DoctorListEntry,
  DoctorReport,
  DoctorSeverity,
} from "./backend.js";
export { SquadDoctorTool, registerSquadDoctorTool } from "./tools.js";

import type { ToolGroup } from "../groups.js";

/** Lazy-loadable tool group — keeps the diagnostic surface out of the
 *  default prompt budget. The agent unlocks it via describe_tool_group. */
export const doctorGroup: ToolGroup = {
  name: "doctor",
  description:
    "Diagnose and repair the squad gateway — memory, database, LLM, filesystem, plugins, MCP, channels, subagents, routines.",
  toolNames: ["squad_doctor"],
  guidance: [
    "Use squad_doctor when the user reports something not working in the",
    "system itself (memory, models, channels, plugins, MCP servers, …) —",
    "not for application code or workspace problems.",
    "",
    "Workflow: first call action=run to enumerate diagnoses, then call",
    "action=fix with the id of any check whose fixable flag is true. Some",
    "errors aren't auto-fixable (broken postgres, missing api keys) —",
    "surface the diagnosis's `remediation` text to the user instead.",
  ].join("\n"),
};
