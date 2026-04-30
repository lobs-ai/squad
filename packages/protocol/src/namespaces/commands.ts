import { z } from "zod";

export const commandScopeSchema = z.enum(["session", "global"]);
export type CommandScope = z.infer<typeof commandScopeSchema>;

export const slashCommandSchema = z.object({
  name: z.string(),
  description: z.string(),
  usage: z.string().optional(),
  scope: z.array(commandScopeSchema).optional(),
  source: z.string().optional(),
});
export type SlashCommandRecord = z.infer<typeof slashCommandSchema>;

export const commandsListParams = z
  .object({ scope: commandScopeSchema.optional() })
  .optional();
export const commandsListResult = z.object({
  commands: z.array(slashCommandSchema),
});

export const commandMethods = {
  "commands.list": { params: commandsListParams, result: commandsListResult },
} as const;
