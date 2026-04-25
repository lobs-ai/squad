/**
 * Path utilities for tool implementations.
 */

import { isAbsolute, resolve } from "node:path";

/**
 * Resolve a path relative to cwd.
 * Absolute paths are returned as-is.
 * Tilde (~) is expanded to the user's home directory — both bare `~`
 * and `~/foo` forms are supported.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  let expanded = filePath;
  if (filePath === "~") expanded = home;
  else if (filePath.startsWith("~/")) expanded = resolve(home, filePath.slice(2));
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}
