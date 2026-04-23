import type { QuestionBackend, AskUserResult } from "@squad/tools";
import type { AskInput } from "@squad/protocol";
import type { QuestionStore } from "./store.js";

/**
 * Adapter that bridges the ask_user tool's QuestionBackend interface to
 * the SQLite-backed QuestionStore.
 */
export function questionBackendFor(store: QuestionStore): QuestionBackend {
  return {
    async ask(input): Promise<AskUserResult> {
      // Normalize the tool-shaped input (multiSelect?: boolean) into the
      // protocol shape (multiSelect: boolean, default false).
      const normalized: AskInput = {
        allowCustom: input.input.allowCustom ?? true,
        ...(input.input.timeoutSeconds !== undefined
          ? { timeoutSeconds: input.input.timeoutSeconds }
          : {}),
        questions: input.input.questions.map((q) => ({
          header: q.header,
          question: q.question,
          multiSelect: q.multiSelect ?? false,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
            ...(o.preview !== undefined ? { preview: o.preview } : {}),
          })),
        })) as AskInput["questions"],
      };
      const { done } = store.ask({
        sessionId: input.sessionId,
        askedBy: input.askedBy,
        input: normalized,
      });
      const record = await done;
      return {
        status: record.status === "pending" ? "cancelled" : record.status,
        ...(record.answers ? { answers: record.answers } : {}),
        ...(record.annotations ? { annotations: record.annotations } : {}),
      };
    },
  };
}
