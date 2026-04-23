import { z } from "zod";

/**
 * Protocol-level error codes. Transport and dispatch layers use these;
 * domain errors from plugins surface as generic `internal_error` with a
 * message. See SPEC.md §Wire Protocol.
 */
export const ErrorCode = {
  parse_error: "parse_error",
  invalid_frame: "invalid_frame",
  unknown_method: "unknown_method",
  invalid_params: "invalid_params",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  not_found: "not_found",
  conflict: "conflict",
  rate_limited: "rate_limited",
  unsupported_capability: "unsupported_capability",
  timeout: "timeout",
  cancelled: "cancelled",
  internal_error: "internal_error",
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export const errorEnvelopeSchema = z.object({
  code: z.nativeEnum(ErrorCode),
  message: z.string(),
  data: z.record(z.unknown()).optional(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

export class ProtocolError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProtocolError";
  }

  toEnvelope(): ErrorEnvelope {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}
