import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Remember the last session id so subcommands can default to it. Written to
 * ~/.squad/state.json — ephemeral, safe to delete.
 */
const STATE_FILE = join(homedir(), ".squad", "state.json");

interface State {
  lastSessionId?: string;
}

function readState(): State {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function writeState(state: State): void {
  mkdirSync(dirname(STATE_FILE), { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function getLastSessionId(): string | undefined {
  return readState().lastSessionId;
}

export function setLastSessionId(id: string): void {
  const s = readState();
  s.lastSessionId = id;
  writeState(s);
}

export function clearLastSessionId(): void {
  const s = readState();
  delete s.lastSessionId;
  writeState(s);
}
