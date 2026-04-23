/**
 * Guidance the ask_user tool surfaces to the agent via its description.
 * Edit deliberately.
 */
export const ASK_GUIDANCE = [
  "Use ask_user to clarify ambiguity, gather a preference, or offer a decision",
  "between concrete approaches. Do NOT use it for 'are you sure?' or 'should I proceed?'.",
  "",
  "- 2–4 options per question, mutually exclusive unless multiSelect is set.",
  "- Order with the recommended choice first and label it (Recommended).",
  "- Do NOT include a literal 'Other' option — the channel always surfaces one.",
  "- Use option.preview when the user benefits from seeing a concrete artifact",
  "  (ASCII mockup, code snippet, config diff). Skip it for pure preference questions.",
].join("\n");
