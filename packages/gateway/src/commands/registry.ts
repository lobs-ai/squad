import type { SlashCommandDescriptor } from "@squad/plugin-sdk";

export type CommandScope = "session" | "global";

/**
 * Slash-command catalog surfaced via `commands.list`. Every client (CLI,
 * dashboard, channel) renders from the same catalog so plugin-contributed
 * commands do not need to ship a per-client registry.
 *
 * Built-in commands (the CLI's `/help`, `/compact`, …) live where they're
 * implemented; the gateway also adopts a small set of canonical built-in
 * commands at boot so a bare client can still discover them.
 */
export class CommandRegistry {
  private readonly entries: Map<string, SlashCommandDescriptor & { source: string }> = new Map();

  register(cmd: SlashCommandDescriptor, source = "plugin"): void {
    if (!cmd.name) throw new Error(`slash command requires a name: ${JSON.stringify(cmd)}`);
    const norm = cmd.name.replace(/^\//, "").trim().toLowerCase();
    if (!norm) throw new Error(`invalid slash command name: "${cmd.name}"`);
    this.entries.set(norm, { ...cmd, name: norm, source });
  }

  list(scope: CommandScope = "session"): Array<SlashCommandDescriptor & { source: string }> {
    return Array.from(this.entries.values()).filter((cmd) => {
      const scopes: CommandScope[] = (cmd.scope as CommandScope[] | undefined) ?? ["session"];
      return scopes.includes(scope);
    });
  }

  /** Built-in catalog — populated at boot. */
  registerBuiltins(): void {
    const builtins: SlashCommandDescriptor[] = [
      { name: "help", description: "Show help text", scope: ["session", "global"] },
      { name: "compact", description: "Request the next turn to compress prior history", scope: ["session"] },
      { name: "usage", description: "Show token usage and context fill", scope: ["session"] },
      { name: "model", description: "Switch the session's primary model", scope: ["session"] },
      { name: "tasks", description: "Open the task list", scope: ["session", "global"] },
      { name: "questions", description: "List open ask-user questions", scope: ["session", "global"] },
      { name: "search", description: "Full-text search across session transcripts", scope: ["session", "global"] },
      { name: "routines", description: "List scheduled routines", scope: ["global"] },
    ];
    for (const cmd of builtins) this.register(cmd, "builtin");
  }
}
