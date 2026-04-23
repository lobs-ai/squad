/**
 * Guidance the tasks tools surface to the agent via their descriptions.
 * Changes here are the single biggest lever on agent behavior — edit
 * deliberately and validate against a real agent run.
 */
export const TASK_GUIDANCE = [
  "When to use tasks:",
  "- Work is multi-step (3+ distinct actions), complex, or the user explicitly asked for a plan.",
  "- Skip for trivial single-step work.",
  "",
  "Status discipline:",
  "- Mark a task in_progress BEFORE starting work, not after.",
  "- Mark completed only when the work is fully done — tests pass, implementation is",
  "  complete, no unresolved errors. On blockers, stay in_progress and create a new",
  "  task describing what's needed.",
  "- If a new dependency surfaces during work, add it with `addBlockedBy` — don't",
  "  silently re-plan.",
  "",
  "Handing off to subagents:",
  "- Include enough detail in `description` that another agent could pick the task up cold.",
  "- A subagent claims a task by setting `owner` via update_task, and moves it to",
  "  in_progress in the same call.",
].join("\n");
