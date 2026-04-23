import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A persistent mapping between channel-native identifiers
 * (e.g. `(guildId, channelId, userId)`) and the gateway's session ids.
 * Keys are arbitrary channel-chosen strings; the file is a newline-delimited
 * JSON log so appends are cheap and crash-safe.
 */
export class SessionMap {
  private readonly entries: Map<string, string> = new Map();

  constructor(private readonly filePath: string) {
    if (existsSync(filePath)) {
      const raw = readFileSync(filePath, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const { key, sessionId } = JSON.parse(line) as { key: string; sessionId: string };
          this.entries.set(key, sessionId);
        } catch {
          // Corrupt line — skip.
        }
      }
    } else {
      mkdirSync(dirname(filePath), { recursive: true });
    }
  }

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, sessionId: string): void {
    this.entries.set(key, sessionId);
    writeFileSync(this.filePath, this.serialize());
  }

  private serialize(): string {
    return (
      Array.from(this.entries.entries())
        .map(([key, sessionId]) => JSON.stringify({ key, sessionId }))
        .join("\n") + "\n"
    );
  }
}
