import {
  MEMORY_BODY_BUDGET,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryProposeInput,
  type MemoryScope,
  type MemoryType,
} from "./types.js";

export interface ValidationProblem {
  field: string;
  message: string;
}

export class MemoryValidationError extends Error {
  constructor(public readonly problems: ValidationProblem[]) {
    super(`memory validation failed: ${problems.map((p) => `${p.field}: ${p.message}`).join("; ")}`);
    this.name = "MemoryValidationError";
  }
}

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _\-./]{1,79}$/;

/**
 * Validate a propose input. Throws MemoryValidationError on bad input;
 * returns a normalized copy of the input on success.
 */
export function validateProposeInput(input: MemoryProposeInput): MemoryProposeInput {
  const problems: ValidationProblem[] = [];
  if (!MEMORY_TYPES.includes(input.type)) {
    problems.push({ field: "type", message: `must be one of ${MEMORY_TYPES.join(", ")}` });
  }
  if (input.scope && !MEMORY_SCOPES.includes(input.scope)) {
    problems.push({ field: "scope", message: `must be one of ${MEMORY_SCOPES.join(", ")}` });
  }
  if (typeof input.name !== "string" || !NAME_RE.test(input.name)) {
    problems.push({
      field: "name",
      message: "must be 2-80 chars; letters, digits, space, _-./",
    });
  }
  if (typeof input.description !== "string" || input.description.trim().length < 4) {
    problems.push({ field: "description", message: "missing or too short (min 4 chars)" });
  } else if (input.description.length > 200) {
    problems.push({ field: "description", message: "max 200 chars; push detail into body" });
  } else if (input.description.includes("\n")) {
    problems.push({ field: "description", message: "must be a single line" });
  }
  if (typeof input.body !== "string" || input.body.trim().length === 0) {
    problems.push({ field: "body", message: "must be non-empty" });
  } else {
    const budget = MEMORY_BODY_BUDGET[input.type as MemoryType] ?? 1000;
    if (input.body.length > budget) {
      problems.push({
        field: "body",
        message: `exceeds ${budget}-char budget for type=${input.type} (got ${input.body.length})`,
      });
    }
  }
  if (input.confidence !== undefined) {
    if (
      !Number.isFinite(input.confidence) ||
      input.confidence < 0 ||
      input.confidence > 100
    ) {
      problems.push({ field: "confidence", message: "must be 0-100" });
    }
  }
  // Scope/scopeKey coherence
  const scope: MemoryScope = (input.scope ?? defaultScopeForType(input.type as MemoryType)) as MemoryScope;
  if (scope === "tree") {
    if (!input.scopeKey || typeof input.scopeKey !== "string") {
      problems.push({ field: "scopeKey", message: "scope=tree requires a scopeKey (root session id)" });
    }
  }
  // Injection scan over body + description
  const hostile = scanForInjection(`${input.description}\n${input.body}`);
  if (hostile) {
    problems.push({ field: "body", message: `injection-like content rejected: ${hostile}` });
  }
  if (problems.length > 0) throw new MemoryValidationError(problems);
  return {
    ...input,
    scope,
    confidence: input.confidence ?? 50,
  };
}

export function defaultScopeForType(t: MemoryType): MemoryScope {
  if (t === "user" || t === "feedback") return "global";
  if (t === "working") return "tree";
  return "project";
}

/**
 * Lightweight prompt-injection / exfil scan. Borrowed in spirit from
 * hermes-agent's memory_tool.py: catch the obvious shapes ("ignore previous
 * instructions", embedded tool-use blocks, raw secret leaks). This is a
 * safety net, not a full filter — high signal patterns only.
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "ignore-instructions", re: /\b(ignore|disregard|forget)\b[^\n]{0,40}\b(previous|prior|above|all|earlier)\b[^\n]{0,40}\b(instruction|prompt|system|rule)/i },
  { name: "system-tag", re: /<\s*\/?\s*(system|s)\s*>/i },
  { name: "tool-result-injection", re: /<\s*tool_(use|result)\b/i },
  { name: "credential-secret", re: /(?:AKIA|sk-[A-Za-z0-9]{12,}|xox[baprs]-[A-Za-z0-9-]{10,}|ghp_[A-Za-z0-9]{20,})/ },
  { name: "shell-exfil", re: /\bcurl\b[^\n]{0,80}\|\s*(?:bash|sh)\b/i },
];

export function scanForInjection(text: string): string | null {
  for (const p of INJECTION_PATTERNS) {
    if (p.re.test(text)) return p.name;
  }
  return null;
}
