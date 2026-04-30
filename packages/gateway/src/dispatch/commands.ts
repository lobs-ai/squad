import type { Dispatcher } from "./index.js";
import type { CommandRegistry, CommandScope } from "../commands/registry.js";

export function registerCommandMethods(
  dispatcher: Dispatcher,
  commands: CommandRegistry,
): void {
  dispatcher.register("commands.list", async (params) => {
    const scope = (params?.scope as CommandScope | undefined) ?? "session";
    const list = commands.list(scope).map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
      ...(cmd.usage ? { usage: cmd.usage } : {}),
      ...(cmd.scope ? { scope: cmd.scope } : {}),
      source: cmd.source,
    }));
    return { commands: list };
  });
}
