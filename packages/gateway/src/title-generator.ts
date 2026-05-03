import { createClient, parseModelString, type LLMClient } from "@squad/llm";
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
  "You name chat sessions. The user turn below is the first message of a new session — your job is to label its TOPIC, not to answer it.",
  "Output exactly one short title and nothing else. No preamble, no answer, no explanation, no markdown, no headings, no bullets, no quotes, no trailing punctuation.",
  "3 to 6 words, Title Case. Never exceed 60 characters.",
  "If the message asks a question or requests work, title it by its SUBJECT (e.g. for 'explain cron jobs', reply 'Cron Jobs Overview' — do NOT start writing the explanation).",
  "Never include the words 'chat', 'conversation', 'session', or 'discussion'.",
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
  /**
   * Optional override applied to every session that hasn't picked its own.
   * When non-empty, we build a dedicated client for this model. When empty
   * we use the gateway's `sharedClient` instead — same path chat takes, so
   * if chat works, titling works.
   */
  configuredModel: () => string | null;
  /**
   * Resolved provider config (api keys, base URLs). Same shape `runs.ts`
   * uses; we hand it to `createClient` when building a dedicated client for
   * a configured `title_model` override.
   */
  resolveConfig: () => ResolveProviderConfigResult;
  /**
   * The gateway's shared LLM client — wraps key rotation and the
   * primary/fallbacks chain. Reused as the default title path so credentials
   * resolved at gateway boot apply uniformly: if chat works, titling works.
   */
  sharedClient?: LLMClient;
  /**
   * Testing seam — when set, every LLM call goes through this client
   * regardless of which path (default vs. explicit-title-model override)
   * we'd otherwise take. Production callers should leave this undefined so
   * `sharedClient` and `createClient` get exercised.
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
    const log = this.deps.logger;
    if (!this.deps.enabled()) {
      log.debug({ sessionId }, "title-generator: skipped — auto_title disabled");
      return;
    }
    const session = this.deps.sessions.tryGet(sessionId);
    if (!session) {
      log.debug({ sessionId }, "title-generator: skipped — session not found");
      return;
    }
    if (!this.needsTitle(session.title)) {
      log.debug(
        { sessionId, title: session.title },
        "title-generator: skipped — session already has a real title",
      );
      return;
    }
    const seed = userMessageText.trim();
    if (!seed) {
      log.debug({ sessionId }, "title-generator: skipped — empty seed");
      return;
    }

    // Pick the client. The default path reuses the gateway's `sharedClient`
    // — that's what chat uses, so its credentials and provider routing are
    // already known to work. We only build a fresh `createClient` when the
    // user explicitly pinned a different title model (per-session override
    // or `chat.title_model` in config), in which case they want that exact
    // model and the chain client wouldn't honor it.
    const explicitOverride = session.titleModel || this.deps.configuredModel() || "";
    const model = explicitOverride || session.model || this.deps.defaultModel;
    if (!model) {
      log.warn(
        { sessionId },
        "title-generator: no model resolvable for session — leaving untitled",
      );
      return;
    }
    log.info(
      {
        sessionId,
        explicitOverride: explicitOverride || null,
        sessionModel: session.model || null,
        defaultModel: this.deps.defaultModel || null,
        seedChars: seed.length,
      },
      "title-generator: starting",
    );

    // Build a candidate list, tried in order:
    //   1. Explicit title model (per-session or `chat.title_model`) — when
    //      set, the user wants this exact model.
    //   2. The gateway's shared client (chat primary + fallback chain) — the
    //      same path chat takes, so credentials are already known to work.
    // First candidate to return non-empty text wins. If the explicit model
    // is misconfigured (bad provider, missing key) we still get a title via
    // the shared client rather than leaving every session untitled.
    interface Candidate {
      client: LLMClient;
      modelLabel: string;
      modelId: string;
    }
    const candidates: Candidate[] = [];

    const toModelId = (m: string): string => {
      try {
        return parseModelString(m).modelId;
      } catch {
        return m;
      }
    };

    if (this.deps.clientOverride) {
      // Test seam — every path runs through the stub.
      candidates.push({
        client: this.deps.clientOverride,
        modelLabel: model,
        modelId: toModelId(model),
      });
    } else {
      if (explicitOverride) {
        try {
          const c = createClient(explicitOverride, this.deps.resolveConfig().clientConfig);
          candidates.push({
            client: c,
            modelLabel: explicitOverride,
            modelId: toModelId(explicitOverride),
          });
          log.debug(
            { sessionId, model: explicitOverride },
            "title-generator: built dedicated client for explicit title model",
          );
        } catch (err) {
          log.warn(
            {
              err,
              sessionId,
              model: explicitOverride,
              hint: "set llm.providers.<provider>.api_key (or its env var) for this title model — falling back to the chat client",
            },
            "title-generator: explicit title model unbuildable",
          );
        }
      }
      if (this.deps.sharedClient) {
        const sharedModel = session.model || this.deps.defaultModel;
        candidates.push({
          client: this.deps.sharedClient,
          modelLabel: `shared:${sharedModel}`,
          modelId: toModelId(sharedModel),
        });
      } else {
        log.debug(
          { sessionId },
          "title-generator: no shared client wired — gateway didn't build one at boot",
        );
      }
    }

    if (candidates.length === 0) {
      log.warn(
        { sessionId, model },
        "title-generator: no LLM client available — check llm.primary.model and llm.providers credentials",
      );
      return;
    }
    log.info(
      { sessionId, candidates: candidates.map((c) => c.modelLabel) },
      "title-generator: trying candidates",
    );

    let title = "";
    let modelLabel = "";
    let lastError: unknown;
    for (const c of candidates) {
      const startedAt = Date.now();
      log.debug(
        { sessionId, model: c.modelLabel, modelId: c.modelId },
        "title-generator: calling LLM",
      );
      try {
        const response = await c.client.createMessage({
          model: c.modelId,
          system: TITLE_SYSTEM_PROMPT,
          // Cap the seed so a giant first paste doesn't blow up the prompt.
          // 800 chars is enough for the model to grasp the topic without
          // paying for a full file dump on every new session.
          messages: [
            {
              role: "user",
              content:
                "First message of the session (do not answer it — name its topic):\n\n<<<\n" +
                (seed.length > 800 ? seed.slice(0, 800) + "…" : seed) +
                "\n>>>\n\nReply with the title only.",
            },
          ],
          tools: [],
          // Reasoning models (minimax M-series, deepseek-r1, GLM, kimi) emit
          // `<think>…</think>` before the answer. With a 40-token budget the
          // think block gets truncated mid-stream, `stripReasoning` deletes
          // the unterminated trailing block, and we end up with an empty
          // string. 1024 is generous enough to fit the reasoning AND a 6-
          // word title, and a one-shot title call doesn't justify squeezing
          // tokens. Non-reasoning models simply stop early — no extra cost.
          maxTokens: 1024,
        });
        const elapsedMs = Date.now() - startedAt;
        const blockTypes = response.content.map((b) => b.type);
        const text = response.content
          .filter((b): b is { type: "text"; text: string } => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        const cleaned = sanitizeTitle(text);
        log.info(
          {
            sessionId,
            model: c.modelLabel,
            elapsedMs,
            stopReason: response.stopReason,
            usage: response.usage,
            blockTypes,
            rawTextChars: text.length,
            // First chars help debug when sanitize strips everything (e.g.
            // model returns reasoning-only output that looks blank).
            rawTextPreview: text.slice(0, 80),
            cleanedTitle: cleaned || null,
          },
          "title-generator: LLM responded",
        );
        if (cleaned) {
          title = cleaned;
          modelLabel = c.modelLabel;
          break;
        }
        log.warn(
          {
            sessionId,
            model: c.modelLabel,
            stopReason: response.stopReason,
            usage: response.usage,
            rawTextChars: text.length,
            rawTextPreview: text.slice(0, 80),
            hint:
              text.length === 0
                ? "model returned no text — likely reasoning-only output truncated by maxTokens, or a non-text content block"
                : "model returned text but sanitize emptied it (all punctuation/quotes?)",
          },
          "title-generator: empty title after sanitize — trying next candidate",
        );
      } catch (err) {
        const elapsedMs = Date.now() - startedAt;
        lastError = err;
        log.warn(
          { err, sessionId, model: c.modelLabel, elapsedMs },
          "title-generator: LLM call failed — trying next candidate",
        );
      }
    }

    // No seed-text fallback: a truncated first message is a worse title than
    // "(untitled)" and silently masks the real problem.
    if (!title) {
      log.warn(
        { sessionId, candidates: candidates.map((c) => c.modelLabel), lastError },
        "title-generator: every candidate failed — leaving session untitled",
      );
      return;
    }

    // Re-check the title between the call kicking off and the response
    // landing — the user may have renamed the session in the meantime, in
    // which case we don't want to clobber their choice.
    const fresh = this.deps.sessions.tryGet(sessionId);
    if (!fresh || !this.needsTitle(fresh.title)) return;
    this.deps.sessions.setTitle(sessionId, title);
    this.deps.logger.info(
      { sessionId, model: modelLabel, title },
      "title-generator: titled session",
    );
  }
}

function sanitizeTitle(raw: string): string {
  // Strip wrapping quotes/whitespace, drop trailing punctuation, hard-cap
  // length. Models occasionally answer with `"My Title."` despite the
  // instruction; cheaper to clean up here than to re-prompt.
  let s = raw.trim();
  // When the model ignores the instruction and starts writing an answer,
  // the response usually opens with a markdown heading and runs to many
  // paragraphs. A 60-char slice of that ("# Squad Cron Jobs Explained##
  // What Are Cron Jobs?Cron jo") is worse than no title — reject it and
  // let the next candidate try. Detection looks at structure on later
  // lines (a leading "# " on its own is just formatting, not evidence of
  // a multi-section document).
  const looksLikeDocument =
    /\n\s*(#{1,6}\s|[-*]\s|\d+\.\s)/.test(s) || s.length > 240;
  if (looksLikeDocument) return "";
  // Take only the first non-empty line — for borderline cases where the
  // model added a one-line title plus a trailing explanation.
  const firstLine = s.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  s = firstLine.trim();
  // Strip any leading markdown heading markers ("# ", "## ", etc.) the
  // model may have prepended despite the instruction.
  s = s.replace(/^#{1,6}\s+/, "").trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).trim();
  if (s.startsWith("'") && s.endsWith("'")) s = s.slice(1, -1).trim();
  s = s.replace(/[.!?]+$/, "").trim();
  if (s.length > TITLE_MAX_LEN) s = s.slice(0, TITLE_MAX_LEN).trim();
  return s;
}
