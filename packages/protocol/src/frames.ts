import { z } from "zod";
import { errorEnvelopeSchema, ProtocolError, ErrorCode } from "./errors.js";

/**
 * Wire-level frame types. Every message on the WebSocket is one of these.
 * See SPEC.md §Wire Protocol.
 */

export const requestFrameSchema = z.object({
  type: z.literal("request"),
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type RequestFrame = z.infer<typeof requestFrameSchema>;

const responseOkSchema = z.object({
  type: z.literal("response"),
  id: z.string().min(1),
  ok: z.literal(true),
  result: z.unknown().optional(),
});
const responseErrSchema = z.object({
  type: z.literal("response"),
  id: z.string().min(1),
  ok: z.literal(false),
  error: errorEnvelopeSchema,
});
export const responseFrameSchema = z.discriminatedUnion("ok", [responseOkSchema, responseErrSchema]);
export type ResponseFrame = z.infer<typeof responseFrameSchema>;

export const eventFrameSchema = z.object({
  type: z.literal("event"),
  topic: z.string().min(1),
  data: z.unknown(),
});
export type EventFrame = z.infer<typeof eventFrameSchema>;

export const subscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  id: z.string().min(1),
  topics: z.array(z.string().min(1)).nonempty(),
});
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;

export const unsubscribeFrameSchema = z.object({
  type: z.literal("unsubscribe"),
  id: z.string().min(1),
  topics: z.array(z.string().min(1)).nonempty(),
});
export type UnsubscribeFrame = z.infer<typeof unsubscribeFrameSchema>;

export const frameSchema = z.union([
  requestFrameSchema,
  responseFrameSchema,
  eventFrameSchema,
  subscribeFrameSchema,
  unsubscribeFrameSchema,
]);
export type Frame = z.infer<typeof frameSchema>;

/**
 * Parse an untrusted value (already JSON-parsed) into a typed frame.
 * Throws `ProtocolError` on failure so callers can turn it into a wire response.
 */
export function parseFrame(value: unknown): Frame {
  const result = frameSchema.safeParse(value);
  if (!result.success) {
    throw new ProtocolError(ErrorCode.invalid_frame, "invalid frame", {
      issues: result.error.issues,
    });
  }
  return result.data;
}

/**
 * Parse a raw string (from the WS transport) into a typed frame. Wraps
 * `JSON.parse` errors as `parse_error` and schema violations as `invalid_frame`.
 */
export function parseFrameString(raw: string): Frame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new ProtocolError(ErrorCode.parse_error, "invalid JSON", {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return parseFrame(json);
}
