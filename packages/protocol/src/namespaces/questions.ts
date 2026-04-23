import { z } from "zod";

export const askOptionSchema = z.object({
  label: z.string().min(1),
  description: z.string(),
  preview: z.string().optional(),
});
export type AskOption = z.infer<typeof askOptionSchema>;

export const askQuestionSchema = z.object({
  header: z.string().min(1),
  question: z.string().min(1),
  options: z.array(askOptionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
});
export type AskQuestion = z.infer<typeof askQuestionSchema>;

export const askInputSchema = z.object({
  questions: z.array(askQuestionSchema).min(1).max(4),
  timeoutSeconds: z.number().int().positive().optional(),
  allowCustom: z.boolean().default(true),
});
export type AskInput = z.infer<typeof askInputSchema>;

export const questionStatusSchema = z.enum([
  "pending",
  "answered",
  "cancelled",
  "timed_out",
]);

export const questionRecordSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  askedBy: z.string(),         // the tool-call id, agent name, or similar
  askedAt: z.string(),
  answeredAt: z.string().nullable(),
  timedOutAt: z.string().nullable(),
  status: questionStatusSchema,
  input: askInputSchema,
  answers: z.record(z.string()).nullable(),
  annotations: z
    .record(z.object({ preview: z.string().optional(), notes: z.string().optional() }))
    .optional(),
});
export type QuestionRecord = z.infer<typeof questionRecordSchema>;

// questions.ask (the gateway writes these via the ask_user tool; clients rarely call directly)
export const questionsAskParams = z.object({
  sessionId: z.string(),
  askedBy: z.string(),
  input: askInputSchema,
});
export const questionsAskResult = z.object({ question: questionRecordSchema });

// questions.answer
export const questionsAnswerParams = z.object({
  sessionId: z.string(),
  questionId: z.string(),
  answers: z.record(z.string()),
  annotations: z
    .record(z.object({ preview: z.string().optional(), notes: z.string().optional() }))
    .optional(),
});
export const questionsAnswerResult = z.object({ question: questionRecordSchema });

// questions.cancel
export const questionsCancelParams = z.object({
  sessionId: z.string(),
  questionId: z.string(),
  reason: z.string().optional(),
});
export const questionsCancelResult = z.object({ question: questionRecordSchema });

// questions.list (pending)
export const questionsListParams = z.object({
  sessionId: z.string().optional(),
  status: z.array(questionStatusSchema).optional(),
});
export const questionsListResult = z.object({ questions: z.array(questionRecordSchema) });

// questions.history
export const questionsHistoryParams = z.object({
  sessionId: z.string(),
  limit: z.number().int().positive().max(500).default(100),
});
export const questionsHistoryResult = z.object({ questions: z.array(questionRecordSchema) });

export const questionMethods = {
  "questions.ask": { params: questionsAskParams, result: questionsAskResult },
  "questions.answer": { params: questionsAnswerParams, result: questionsAnswerResult },
  "questions.cancel": { params: questionsCancelParams, result: questionsCancelResult },
  "questions.list": { params: questionsListParams, result: questionsListResult },
  "questions.history": { params: questionsHistoryParams, result: questionsHistoryResult },
} as const;

// ── Events ────────────────────────────────────────────────────────────────────

export const questionAskedEvent = z.object({ question: questionRecordSchema });
export const questionAnsweredEvent = z.object({ question: questionRecordSchema });
export const questionCancelledEvent = z.object({ question: questionRecordSchema });
export const questionTimedOutEvent = z.object({ question: questionRecordSchema });

export const questionEvents = {
  "questions.asked": questionAskedEvent,
  "questions.answered": questionAnsweredEvent,
  "questions.cancelled": questionCancelledEvent,
  "questions.timed_out": questionTimedOutEvent,
} as const;
