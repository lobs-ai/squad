/**
 * Chunk a long string into Discord-safe pieces (default cap 1900 chars
 * for a comfortable margin under Discord's 2000-char limit).
 */
export function chunkMessage(input: string, limit: number): string[] {
  if (input.length <= limit) return [input];
  const out: string[] = [];
  let remaining = input;
  while (remaining.length > limit) {
    // Try to break on a newline, then a space, then anywhere.
    let cut = remaining.lastIndexOf("\n", limit);
    if (cut < limit / 2) cut = remaining.lastIndexOf(" ", limit);
    if (cut < limit / 2) cut = limit;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).replace(/^\s+/, "");
  }
  if (remaining.length > 0) out.push(remaining);
  return out;
}
