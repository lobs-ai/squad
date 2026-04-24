/**
 * Path utilities for tool implementations.
 */

import { resolve } from "node:path";

/**
 * Resolve a path relative to cwd.
 * Absolute paths are returned as-is.
 * Tilde (~) is expanded to the user's home directory.
 */
export function resolveToCwd(filePath: string, cwd: string): string {
  if (filePath.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return resolve(home, filePath.slice(2));
  }
  return resolve(cwd, filePath);
}
