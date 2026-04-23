import type { Dispatcher } from "./index.js";
import type { QuestionStore } from "../questions/store.js";
import { ProtocolError, ErrorCode } from "@squad/protocol";

export function registerQuestionMethods(
  dispatcher: Dispatcher,
  store: QuestionStore,
): void {
  dispatcher.register("questions.ask", async (params) => {
    const { id } = store.ask({
      sessionId: params.sessionId,
      askedBy: params.askedBy,
      input: params.input,
    });
    return { question: store.get(id) };
  });

  dispatcher.register("questions.answer", async (params) => {
    const question = store.answer(
      params.sessionId,
      params.questionId,
      params.answers,
      params.annotations,
    );
    return { question };
  });

  dispatcher.register("questions.cancel", async (params) => {
    const question = store.cancel(
      params.sessionId,
      params.questionId,
      params.reason,
    );
    return { question };
  });

  dispatcher.register("questions.list", async (params) => ({
    questions: store.list({
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.status !== undefined ? { status: params.status } : {}),
    }),
  }));

  dispatcher.register("questions.history", async (params) => ({
    questions: store.history(params.sessionId, params.limit),
  }));

  // Silence unused ProtocolError/ErrorCode import when no custom errors are thrown.
  void ProtocolError;
  void ErrorCode;
}
