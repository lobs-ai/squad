import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as DatabaseHandle } from "better-sqlite3";
import { runMigrations } from "./migrations.js";

export interface OpenOptions {
  path: string;
  readonly?: boolean;
}

export function openDb(options: OpenOptions): DatabaseHandle {
  mkdirSync(dirname(options.path), { recursive: true });
  const db = new Database(options.path, { readonly: options.readonly ?? false });
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

export type { DatabaseHandle };
