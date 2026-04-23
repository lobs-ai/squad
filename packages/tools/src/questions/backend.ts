/**
 * QuestionBackend — minimal interface the ask_user tool talks to.
 *
 * The gateway implements this in terms of its QuestionStore. The tools
 * package stays ignorant of SQLite and broadcast concerns.
 */

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  header: string;
  question: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface AskInput {
  questions: AskQuestion[];
  timeoutSeconds?: number;
  allowCustom?: boolean;
}

export interface AskResult {
  status: "answered" | "cancelled" | "timed_out";
  answers?: Record<string, string>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
}

export interface QuestionBackend {
  ask(input: { sessionId: string; askedBy: string; input: AskInput }): Promise<AskResult>;
}
