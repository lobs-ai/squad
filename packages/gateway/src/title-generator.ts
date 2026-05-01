import { createClient, type LLMClient } from "@squad/llm";
import type { SessionStore } from "./db/sessions.js";
import type { Logger } from "./logger.js";
import type { ResolveProviderConfigResult } from "./llm-config.js";

/**
 * Heuristic — anything shorter than this is treated as missing. Our default
 * CLI title was "cli", which we want to overwrite once a real first message
 * arrives. Anything a user typed by hand is kept as-is.
 */
const PLACEHOLDER_TITLES = new Set(["", "cli", "untitled", "new", "chat"]);

const TITLE_MAX_LEN = 60;

const TITLE_SYSTEM_PROMPT = [
  "You generate short, specific chat titles.",
  "Reply with the title and nothing else — no quotes, no punctuation at the end, no explanations.",
  "Aim for 3 to 6 words. Capture the topic, not the user's tone.",
  "Never exceed 60 characters. Never include the word 'chat' or 'conversation'.",
].join(" ");

export interface TitleGeneratorDeps {
  sessions: SessionStore;
  logger: Logger;
  /**
   * Default model when neither the session nor the gateway config picks one.
   * Usually `config.llm.primary.model`.
   */
  defaultModel: string;
  /**
   * Live read of the `chat.auto_title` toggle. Checked on every call so
   * flipping the setting takes effect without a gateway restart.
   */
  enabled: () => boolean;
  /** Optional override applied to every session that hasn't picked its own. */
  configuredModel: () => string | null;
  /**
   * Resolved provider config (api keys, base URLs). Same shape `runs.ts`
   * uses; we hand it to `createClient` so the chosen model picks up the
   * user-configured credentials.
   */
  resolveConfig: () => ResolveProviderConfigResult;
  /**
   * Testing seam — bypasses createClient and provider resolution. Production
   * callers should leave this undefined so the resolved title model is
   * actually honored (a chain client would clobber the model parameter).
   */
  clientOverride?: LLMClient;
}

/**
 * Owns the "auto-name a session from its first user message" behaviour.
 *
 * The generator is fire-and-forget: callers should not await it on the hot
 * chat path. A failure to title is never fatal — the user can always rename
 * the session by hand.
 */
export class TitleGenerator {
  constructor(private readonly deps: TitleGeneratorDeps) {}

  /**
   * Pick the model id this session should use for title generation.
   *
   * Priority: per-session override > gateway config override > session's
   * own primary model > gateway default. The last two converge on the
   * user's "main" model, which is what we want by default.
   */
  resolveModel(sessionId: string): string {
    const session = this.deps.sessions.tryGet(sessionId);
    if (session?.titleModel) return session.titleModel;
    const configured = this.deps.configuredModel();
    if (configured) return configured;
    if (session?.model) return session.model;
    return this.deps.defaultModel;
  }

  /**
   * Returns true when a session's title is missing or matches one of our
   * known placeholders. Anything the user (or another agent) set by hand
   * is left alone — auto-titling never overwrites a real title.
   */
  needsTitle(title: string | null | undefined): boolean {
    if (title == null) return true;
    return PLACEHOLDER_TITLES.has(title.trim().toLowerCase());
  }

  /**
   * Generate a title for `sessionId` based on the first user message text.
   * No-op when the session already has a non-placeholder title or the LLM
   * call fails. Caller should not await — runs in the background.
   */
  async generateIfNeeded(sessionId: string, userMessageText: string): Promise<void> {
    if (!this.deps.enabled()) return;
    const session = this.deps.sessions.tryGet(sessionId);
    if (!session) return;
    if (!this.needsTitle(session.title)) return;
    const seed = userMessageText.trim();
    if (!seed) return;

    const model = this.resolveModel(sessionId);
    let client: LLMClient;
    try {
      client = this.deps.clientOverride ?? createClient(model, this.deps.resolveConfig().clientConfig);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId, model },
        "title-generator: could not build LLM client — skipping",
      );
      return;
    }

    let title: string;
    try {
      const response = await client.createMessage({
        model,
        system: TITLE_SYSTEM_PROMPT,
        // Cap the seed so a giant first paste doesn't blow up the prompt.
        // 800 chars is enough for the model to grasp the topic without paying
        // for a full file dump on every new session.
        messages: [
          {
            role: "user",
            content: seed.length > 800 ? seed.slice(0, 800) + "…" : seed,
          },
        ],
        tools: [],
        maxTokens: 40,
      });
      const text = response.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ")
        .trim();
      title = sanitizeTitle(text);
    } catch (err) {
      this.deps.logger.warn(
        { err, sessionId, model },
        "title-generator: LLM call failed — leaving session untitled",
      );
      return;
    }

    if (!title) return;

    // Re-check the title between the call kicking off and the response
    // landing — the user may have renamed the session in the meantime, in
    // which case we don't want to clobber their choice.
    const fresh = this.deps.sessions.tryGet(sessionId);
    if (!fresh || !this.needsTitle(fresh.title)) return;
    this.deps.sessions.setTitle(sessionId, title);
    this.deps.logger.info(
      { sessionId, model, title },
      "title-generator: titled session",
    );
  }
}

function sanitizeTitle(raw: string): string {
  // Strip wrapping quotes/whitespace, drop trailing punctuation, hard-cap
  // length. Models occasionally answer with `"My Title."` despite the
  // instruction; cheaper to clean up here than to re-prompt.
  let s = raw.trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
  s = s.replace(/[.!?]+$/, "").trim();
  if (s.length > TITLE_MAX_LEN) s = s.slice(0, TITLE_MAX_LEN).trim();
  return s;
}
