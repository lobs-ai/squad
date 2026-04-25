import { homedir } from "node:os";
import { join } from "node:path";

export const SQUAD_HOME = join(homedir(), ".squad");
export const REGISTRY_PATH = join(SQUAD_HOME, "squads.json");
export const COMPOSE_PATH = join(SQUAD_HOME, "docker-compose.yml");
export const SQUADS_DIR = join(SQUAD_HOME, "squads");
export const SHARED_DIR = join(SQUAD_HOME, "shared");
export const EXTENSIONS_DIR = join(SQUAD_HOME, "extensions");
export const CURRENT_FILE = join(SQUAD_HOME, "current");

export function squadDir(name: string): string {
  return join(SQUADS_DIR, name);
}

export function squadConfigPath(name: string): string {
  return join(squadDir(name), "config.json");
}

export function squadEnvPath(name: string): string {
  return join(squadDir(name), ".env");
}

export function squadDataDir(name: string): string {
  return join(squadDir(name), "data");
}
