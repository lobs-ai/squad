import { readFileSync } from "node:fs";
import { z } from "zod";

const authTokenSchema = z.object({
  label: z.string(),
  key_env: z.string().optional(),
  key: z.string().optional(),
  scopes: z.array(z.string()).default(["*"]),
});

/**
 * One concrete key (literal or env-var pointer) inside a key pool. Tagged
 * with an optional `label` so 429 backoff and dashboards can refer to a key
 * without leaking its value.
 */
const keyEntrySchema = z.preprocess(
  (raw) => (typeof raw === "string" ? { key: raw } : raw),
  z.object({
    key: z.string().optional(),
    key_env: z.string().optional(),
    label: z.string().optional(),
  }),
);

const providerConfigSchema = z.object({
  api_key_env: z.string().optional(),
  api_key: z.string().optional(),
  /**
   * Optional pool of additional keys. The gateway rotates round-robin across
   * the (api_key + keys[]) union and excludes any key that produces a 429
   * or 5xx for a backoff window. Each entry can be a literal string, a
   * `{ key }` object, or a `{ key_env }` env-var reference.
   */
  keys: z.array(keyEntrySchema).optional(),
  base_url: z.string().optional(),
});

/**
 * How messages sent while a run is already in flight are delivered.
 *
 * - "interrupt" (default): the new message is queued and injected into the
 *   running agent at the start of its next LLM turn. The user sees it
 *   acknowledged at the end of the current tool call, not after the whole
 *   conversation completes. Best for chat-native UX.
 * - "queue": the new message waits until the current run fully finishes,
 *   then triggers a fresh turn. Arriving messages are served one at a time,
 *   in order. Best when agents should never be interrupted mid-thought.
 */
export const DELIVERY_MODES = ["interrupt", "queue"] as const;
export type DeliveryMode = (typeof DELIVERY_MODES)[number];

/**
 * Delivery config accepts three shapes for ergonomics. After parsing they
 * all normalize to the same internal shape.
 *
 *   { "chat": { "delivery": "interrupt" } }
 *   { "chat": { "delivery_mode": "interrupt" } }
 *   { "chat": { "delivery": { "mode": "interrupt", "max_queued": 50 } } }
 */
const deliveryObjectSchema = z
  .object({
    mode: z.enum(DELIVERY_MODES).default("interrupt"),
    max_queued: z.number().int().positive().max(1000).default(50),
    collapse_duplicates: z.boolean().default(true),
  })
  .default({});

const chatConfigSchema = z
  .preprocess((raw) => {
    if (raw === undefined || raw === null) return {};
    if (typeof raw !== "object") return raw;
    const obj = raw as Record<string, unknown>;
    const normalized: Record<string, unknown> = { ...obj };
    if (typeof normalized.delivery === "string") {
      normalized.delivery = { mode: normalized.delivery };
    }
    if (typeof normalized.delivery_mode === "string") {
      const existing =
        typeof normalized.delivery === "object" && normalized.delivery !== null
          ? (normalized.delivery as Record<string, unknown>)
          : {};
      normalized.delivery = { mode: normalized.delivery_mode, ...existing };
      delete normalized.delivery_mode;
    }
    return normalized;
  }, z.object({
    delivery: deliveryObjectSchema,
    /**
     * Model id used to auto-name new sessions from their first user message.
     * Empty string (the default) inherits the session's primary model — i.e.
     * "main". Override globally to point title generation at a cheaper model
     * without changing the chat model. Per-session overrides set via
     * `session.setTitleModel` win over this.
     */
    title_model: z.string().default(""),
    /**
     * Backup model used when `title_model` (or, if unset, the session's own
     * model) fails — e.g. a typo'd or retired chat model that the provider
     * 400s on. Empty string falls back to `llm.primary.model`. Set this to a
     * known-good cheap model so a bad chat model doesn't leave every session
     * untitled.
     */
    title_fallback_model: z.string().default(""),
    /**
     * Master switch for the auto-title behaviour. Off-by-default would force
     * every new install to opt in to a feature most people want, so we keep
     * it on; users uncomfortable with the LLM call can flip this to false.
     */
    auto_title: z.boolean().default(true),
  }))
  .default({});

/**
 * Model reference for `llm.primary` / `llm.fallbacks[]`. A bare string is
 * shorthand for `{ "model": "<string>" }` — both accepted so config can stay
 * compact while leaving room for per-model knobs later (maxTokens, temp, …).
 */
const modelRefSchema = z.preprocess(
  (raw) => (typeof raw === "string" ? { model: raw } : raw),
  z.object({ model: z.string().min(1) }),
);

const llmConfigSchema = z
  .object({
    /** The first model the runner tries for any new session. */
    primary: modelRefSchema.default({ model: "claude-sonnet-4-5" }),
    /**
     * Ordered fallbacks. If `primary` fails with a fallback-eligible error
     * (rate limit, 5xx, timeout, network), the runner advances to the next
     * model in this list and sticks there for the rest of the session.
     * Auth and invalid-request failures bypass the chain.
     */
    fallbacks: z.array(modelRefSchema).default([]),
    /** Keys / base URLs per provider. */
    providers: z.record(providerConfigSchema).default({}),
  })
  .default({
    primary: { model: "claude-sonnet-4-5" },
    fallbacks: [],
    providers: {},
  });

export const configSchema = z.object({
  server: z
    .object({
      host: z.string().default("0.0.0.0"),
      port: z.number().int().nonnegative().default(8080),
      data_dir: z.string().default("./data"),
      /**
       * Persistent home directory the agent runs in. The runner sets this as
       * the cwd for every chat turn and every subagent, so file/exec tools
       * land here instead of wherever the gateway was launched from. Shared
       * across sessions on purpose — agents accumulate state here. Created
       * on boot if it doesn't exist.
       *
       * Empty string (the default) means "derive from data_dir" — boot picks
       * `<data_dir>/workspace` so test fixtures pointing data_dir at a tmpdir
       * automatically isolate their workspace too.
       */
      workspace_dir: z.string().default(""),
      /**
       * MemCore is the sole memory backend. Set `database_url` (or the
       * MEMCORE_DATABASE_URL env var) — boot fails fast otherwise.
       */
      memcore: z
        .object({
          /** Postgres connection string. Falls back to MEMCORE_DATABASE_URL. */
          database_url: z.string().default(""),
          /**
           * Container tag (multi-tenant scope). Empty string (the default)
           * derives from `server.squad_name`, so each squad managed by
           * `squad mgr` is automatically its own tenant. Override only when
           * you want two squads to share a memory pool.
           */
          container_tag: z.string().default(""),
          /** Embedder API key env var. Falls back to OPENAI_API_KEY. */
          embedding_api_key_env: z.string().default("OPENAI_API_KEY"),
          /** Embedder base URL. Falls back to OpenAI. */
          embedding_base_url: z.string().default(""),
          /** Embedding model name. */
          embedding_model: z.string().default("text-embedding-3-large"),
          /** Embedding dim — only relevant when overriding the model. */
          embedding_dim: z.number().int().positive().default(3072),
          /**
           * Default model for every MemCore processing stage. Empty string
           * (the default) inherits `llm.primary.model`, so memory ops follow
           * the squad's main model unless explicitly overridden.
           */
          processing_model: z.string().default(""),
          /**
           * Per-stage overrides. Each empty string falls back to
           * `processing_model`, then to `llm.primary.model`. Lets you tune
           * extraction quality vs. cost without changing the squad's main
           * model.
           */
          extraction_model: z.string().default(""),
          contextualizer_model: z.string().default(""),
          conflict_model: z.string().default(""),
          temporal_parser_model: z.string().default(""),
          profile_generator_model: z.string().default(""),
          /**
           * Cosine-similarity floor below which `memcore.search` returns an
           * empty result list (RAG abstain). 0 disables the gate, which is
           * what the typed-memory tools want — the agent explicitly asked for
           * results, so even a weak match is more useful than silence. Crank
           * back up (memcore default was 0.3) if you wire up RAG-style
           * automatic injection where hallucination from thin matches is the
           * bigger risk.
           */
          abstain_similarity_floor: z.number().min(0).max(1).default(0),
          /**
           * Idle-driven incremental ingestion: a sweeper periodically picks
           * sessions that have gone quiet and feeds the unprocessed message
           * delta into MemCore's extraction pipeline. Watermarks track what's
           * already been ingested so resuming an old chat just continues.
           */
          ingest: z
            .object({
              /** Seconds of inactivity before a session is eligible. */
              idle_threshold_seconds: z.number().int().positive().default(1800),
              /**
               * Hard ceiling — once a session has unprocessed content older
               * than this, force-ingest even if the min-delta gates haven't
               * been hit. Stops content from leaking forever.
               */
              max_idle_seconds: z.number().int().positive().default(86400),
              /** Skip ingestion when the unprocessed delta is smaller than this. */
              min_delta_messages: z.number().int().nonnegative().default(4),
              /** Token budget gate — same role as min_delta_messages. */
              min_delta_tokens: z.number().int().nonnegative().default(200),
              /**
               * Default false: subagent transcripts are usually summarised by
               * the parent's reply, so ingesting them double-counts learnings.
               */
              include_subagents: z.boolean().default(false),
              /** How often the idle sweeper runs. */
              sweeper_interval_seconds: z.number().int().positive().default(60),
            })
            .default({}),
        })
        .default({}),
      /**
       * Squad name as seen by the manager (matches the docker compose service
       * `squad-<name>`). Defaults to "default" — the value the dashboard's
       * SquadPicker shows in single-squad installs. Override per-squad via the
       * SQUAD_NAME env var or by injecting it through the JSON config.
       */
      squad_name: z.string().default("default"),
      /**
       * Short build identifier surfaced via `admin.identity` (a git sha,
       * usually). Empty falls back to the gateway VERSION.
       */
      build: z.string().default(""),
    })
    .default({}),
  auth: z
    .object({
      tokens: z.array(authTokenSchema).default([]),
    })
    .default({ tokens: [] }),
  llm: llmConfigSchema,
  subagents: z
    .object({
      max_concurrent_global: z.number().int().positive().default(8),
      max_concurrent_per_parent: z.number().int().positive().default(4),
      max_tree_depth: z.number().int().positive().default(3),
    })
    .default({}),
  policy: z
    .object({
      approvals: z
        .object({
          default: z.enum(["tag-match", "allow-all", "deny-all"]).default("tag-match"),
          require_for_tags: z.array(z.string()).default(["write", "exec", "network"]),
          /**
           * Specific tool names that always require approval, regardless of
           * tags. Lets you require approval for, say, `Bash` without gating
           * everything tagged `exec`. Independent of `require_for_tags` —
           * either match escalates.
           */
          require_for_tools: z.array(z.string()).default([]),
          timeout_seconds: z.number().int().positive().default(120),
        })
        .default({}),
    })
    .default({}),
  chat: chatConfigSchema,
  /**
   * Display labels surfaced through `admin.identity.branding`. Lets an
   * install rebrand the assistant and the user speaker label without forking
   * the dashboard or CLI. Empty strings inherit the generic defaults
   * ("agent" / "you"). Internal role/owner enums are unchanged — these
   * strictly affect UI labels. We don't expose a subagent label because
   * subagents aren't a fixed identity: the agent spawns them ad-hoc per
   * task, so a single rebrand wouldn't be meaningful.
   */
  branding: z
    .object({
      agent_name: z.string().default("agent"),
      user_name: z.string().default("you"),
    })
    .default({}),
  // A plugin entry is either a bare specifier / path string or an object with
  // a `path` and optional `config`. The gateway knows nothing about what any
  // individual plugin does; channels, extra tools, skills, providers, and
  // routines all arrive this way.
  plugins: z
    .array(
      z.union([
        z.string(),
        z.object({
          path: z.string(),
          config: z.record(z.unknown()).default({}),
        }),
      ]),
    )
    .default([]),
  // MCP — Model Context Protocol — servers. Each entry spawns a stdio server
  // at boot; its advertised tools land in the regular `ToolRegistry` and
  // are indistinguishable from native tools at the agent loop layer.
  mcp: z
    .object({
      servers: z
        .array(
          z.object({
            id: z.string().min(1),
            command: z.string().min(1),
            args: z.array(z.string()).optional(),
            env: z.record(z.string()).optional(),
            cwd: z.string().optional(),
            allow: z.array(z.string()).optional(),
            deny: z.array(z.string()).optional(),
            sample: z.number().int().positive().optional(),
            tags: z.array(z.string()).optional(),
          }),
        )
        .default([]),
    })
    .default({ servers: [] }),
});

export type Config = z.infer<typeof configSchema>;

/** Input shape accepted by `boot()` and `configSchema.parse()`. */
export type ConfigInput = z.input<typeof configSchema>;

export function loadConfig(path: string | undefined): Config {
  if (!path) return configSchema.parse({});
  const raw = readFileSync(path, "utf8");
  const trimmed = raw.trim();
  // Treat an empty file like `{}` so setup can land on a path that exists
  // but hasn't been filled in yet.
  const parsed = trimmed.length === 0 ? {} : JSON.parse(trimmed);
  return configSchema.parse(parsed);
}

/**
 * Resolve every auth token's actual secret value. Tokens configured with
 * `key_env` read from the environment; tokens with literal `key` are used
 * as-is. Throws if a configured env var is unset.
 */
export function resolveTokenSecrets(config: Config): Array<{
  label: string;
  secret: string;
  scopes: string[];
}> {
  return config.auth.tokens.map((t) => {
    const secret = t.key ?? (t.key_env ? process.env[t.key_env] : undefined);
    if (!secret) {
      throw new Error(
        `Auth token "${t.label}" has no secret (set config.auth.tokens[].key or the ${t.key_env} env var)`,
      );
    }
    return { label: t.label, secret, scopes: t.scopes };
  });
}
