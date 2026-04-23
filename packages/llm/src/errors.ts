/**
 * LLM error classification.
 *
 * Wraps errors from the various provider SDKs (Anthropic, OpenAI, OpenAI-
 * compatible) into a normalised `LLMErrorType` so the fallback chain can
 * decide whether to advance to the next model or surface the error.
 *
 * Classification drives two things:
 *
 *   - `transient` — is the error likely to resolve on its own (rate limit,
 *     5xx, network blip)? Transient errors skip the current model and try
 *     the next one in the chain.
 *   - `eligibleForFallback` — is it safe to try a different model? Auth and
 *     invalid-request failures are not: they mean the caller misconfigured
 *     this model, and retrying a *different* model silently would hide the
 *     bug. Those bubble up immediately.
 */

export type LLMErrorType =
  | "rate_limit"
  | "auth_error"
  | "quota_exceeded"
  | "timeout"
  | "server_error"
  | "invalid_request"
  | "model_not_found"
  | "network"
  | "unknown";

export interface ClassifiedError {
  type: LLMErrorType;
  /** Raw error message for logs. */
  message: string;
  /** HTTP status, if we could pull one off the error. */
  status?: number;
  /** Would a retry (same model) plausibly succeed? */
  transient: boolean;
  /** Can the chain try a different model next? */
  eligibleForFallback: boolean;
}

function readStatus(err: unknown): number | undefined {
  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    if (typeof anyErr["status"] === "number") return anyErr["status"] as number;
    if (typeof anyErr["statusCode"] === "number") return anyErr["statusCode"] as number;
    const resp = anyErr["response"];
    if (resp && typeof resp === "object") {
      const r = resp as Record<string, unknown>;
      if (typeof r["status"] === "number") return r["status"] as number;
    }
  }
  return undefined;
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Classify an error thrown from an LLM client into a `ClassifiedError`.
 *
 * Detection order:
 *   1. HTTP status codes (most reliable) — 401/403, 429, 5xx, 404, 408.
 *   2. Error name / code fields set by fetch + node (`AbortError`, `ECONNRESET`).
 *   3. Substring match on the message — a last-resort, kept narrow so we
 *      don't misclassify unrelated errors.
 */
export function classifyError(err: unknown): ClassifiedError {
  const message = readMessage(err);
  const status = readStatus(err);
  const lower = message.toLowerCase();
  const name = err instanceof Error ? err.name : "";
  const code = err && typeof err === "object" ? (err as { code?: unknown }).code : undefined;

  // ── Status-code driven ────────────────────────────────────────────────────
  if (status === 429) {
    return wrap("rate_limit", message, status, { transient: true, eligibleForFallback: true });
  }
  if (status === 401 || status === 403) {
    // Auth is per-key: another model may use a different key. Fall back — but
    // surface the reason so operators can fix the misconfig.
    return wrap("auth_error", message, status, { transient: false, eligibleForFallback: true });
  }
  if (status === 402 || /quota|billing/.test(lower)) {
    return wrap("quota_exceeded", message, status, { transient: false, eligibleForFallback: true });
  }
  if (status === 404 || /model.*not.*found|unknown model|invalid model/.test(lower)) {
    return wrap("model_not_found", message, status, { transient: false, eligibleForFallback: true });
  }
  if (status === 408 || name === "AbortError" || /timeout|timed out/.test(lower)) {
    return wrap("timeout", message, status, { transient: true, eligibleForFallback: true });
  }
  if (status === 400 || status === 422) {
    // The request itself is wrong (bad tool schema, bad message shape, token
    // limit exceeded). A different model won't help. Bubble up.
    return wrap("invalid_request", message, status, { transient: false, eligibleForFallback: false });
  }
  if (typeof status === "number" && status >= 500 && status < 600) {
    return wrap("server_error", message, status, { transient: true, eligibleForFallback: true });
  }

  // ── Node/fetch-level network errors ──────────────────────────────────────
  const netCodes = new Set(["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);
  if (typeof code === "string" && netCodes.has(code)) {
    return wrap("network", message, status, { transient: true, eligibleForFallback: true });
  }
  if (/fetch failed|network|socket hang up/.test(lower)) {
    return wrap("network", message, status, { transient: true, eligibleForFallback: true });
  }
  if (/overloaded|529/.test(lower)) {
    return wrap("server_error", message, status, { transient: true, eligibleForFallback: true });
  }

  // ── Unknown — cautiously allow fallback but flag as non-transient ────────
  return wrap("unknown", message, status, { transient: false, eligibleForFallback: true });
}

function wrap(
  type: LLMErrorType,
  message: string,
  status: number | undefined,
  flags: { transient: boolean; eligibleForFallback: boolean },
): ClassifiedError {
  return { type, message, ...(status !== undefined ? { status } : {}), ...flags };
}
