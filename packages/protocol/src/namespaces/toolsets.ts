import { z } from "zod";

export const toolsetRecordSchema = z.object({
  name: z.string(),
  description: z.string(),
  tools: z.array(z.string()),
  requires: z.array(z.string()).optional(),
});
export type ToolsetRecord = z.infer<typeof toolsetRecordSchema>;

export const toolsetsListParams = z.object({}).optional();
export const toolsetsListResult = z.object({
  toolsets: z.array(toolsetRecordSchema),
});

export const toolsetsResolveParams = z.object({
  name: z.string().min(1),
});
export const toolsetsResolveResult = z.object({
  name: z.string(),
  tools: z.array(z.string()),
});

export const toolsetMethods = {
  "toolsets.list": { params: toolsetsListParams, result: toolsetsListResult },
  "toolsets.resolve": { params: toolsetsResolveParams, result: toolsetsResolveResult },
} as const;
