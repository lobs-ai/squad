/**
 * Smart output capping for tool results.
 *
 * Shows the model a useful preview by default; it can request more with
 * offset/limit. This prevents context bloat at the source rather than
 * pruning it after the fact.
 */

export const DEFAULT_OUTPUT_CAP = 50_000;
export const DEFAULT_MAX_LINES = 2000;

/**
 * Cap a tool result string to a budget.
 *
 * @param output   - Full tool output
 * @param maxChars - Character budget (default 50 000)
 * @param maxLines - Line budget (default 2000)
 * @param hint     - Optional extra hint appended to the truncation notice
 */
export function capOutput(
  output: string,
  maxChars = DEFAULT_OUTPUT_CAP,
  maxLines = DEFAULT_MAX_LINES,
  hint?: string,
): string {
  if (output.length <= maxChars) {
    const lines = output.split("\n");
    if (lines.length <= maxLines) return output;

    const kept = lines.slice(0, maxLines).join("\n");
    const remaining = lines.length - maxLines;
    const notice = hint
      ? `\n\n[${remaining} more lines. ${hint}]`
      : `\n\n[${remaining} more lines truncated.]`;
    return kept + notice;
  }

  let truncated = output.slice(0, maxChars);
  const lastNewline = truncated.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.7) {
    truncated = truncated.slice(0, lastNewline);
  }

  const shownLines = truncated.split("\n").length;
  const totalLines = output.split("\n").length;
  const remaining = totalLines - shownLines;
  const remainingChars = output.length - truncated.length;

  const parts = [`${remaining} more lines (~${Math.round(remainingChars / 1000)}K chars)`];
  if (hint) parts.push(hint);

  return truncated + `\n\n[${parts.join(". ")}]`;
}
