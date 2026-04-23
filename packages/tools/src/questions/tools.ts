import { BaseTool, type ToolContext } from "../base-tool.js";
import type { ToolExecutorResult } from "../types.js";
import type { AskInput, QuestionBackend } from "./backend.js";
import { ASK_GUIDANCE } from "./prompt.js";

function sessionIdFrom(ctx: ToolContext): string {
  const sid = (ctx.meta?.sessionId as string | undefined) ?? undefined;
  if (!sid) throw new Error("ask_user requires `sessionId` in the agent context");
  return sid;
}

function toolIdFrom(ctx: ToolContext): string {
  return (ctx.meta?.toolUseId as string | undefined) ?? "ask_user";
}

interface AskUserInput extends Record<string, unknown> {
  questions: AskInput["questions"];
  timeoutSeconds?: number;
  allowCustom?: boolean;
}

export class AskUserTool extends BaseTool<AskUserInput> {
  readonly name = "ask_user";
  readonly description = [
    "Ask the user 1–4 structured multiple-choice questions. Returns once the",
    "user answers, cancels, or the question times out. Each channel renders",
    "questions natively (Discord buttons, dashboard cards, CLI select).",
    "",
    ASK_GUIDANCE,
  ].join("\n");
  readonly inputSchema = {
    type: "object" as const,
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            header: { type: "string" },
            question: { type: "string" },
            multiSelect: { type: "boolean" },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string" },
                  description: { type: "string" },
                  preview: { type: "string" },
                },
                required: ["label", "description"],
              },
            },
          },
          required: ["header", "question", "options"],
        },
      },
      timeoutSeconds: { type: "number" },
      allowCustom: { type: "boolean" },
    },
    required: ["questions"],
  };
  readonly tags = ["readonly"] as const;

  constructor(private readonly backend: QuestionBackend) {
    super();
  }

  async run(input: AskUserInput, ctx: ToolContext): Promise<ToolExecutorResult> {
    const askInput: AskInput = {
      questions: input.questions,
      allowCustom: input.allowCustom ?? true,
      ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
    };
    const result = await this.backend.ask({
      sessionId: sessionIdFrom(ctx),
      askedBy: toolIdFrom(ctx),
      input: askInput,
    });
    return {
      result: JSON.stringify(
        {
          status: result.status,
          answers: result.answers ?? {},
          ...(result.annotations !== undefined ? { annotations: result.annotations } : {}),
        },
        null,
        2,
      ),
    };
  }
}

type AnyTool = BaseTool<Record<string, unknown>>;

export function registerAskUserTool(
  registry: { register(tool: AnyTool): unknown },
  backend: QuestionBackend,
): void {
  registry.register(new AskUserTool(backend) as unknown as AnyTool);
}
