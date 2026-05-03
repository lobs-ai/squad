/**
 * Canonical prompt-fragment slot taxonomy.
 *
 * Every fragment a plugin contributes via `api.promptFragments.register`
 * targets one of these slots. Tools that render conditional sections look
 * fragments up by the same constant. Adding a new extension point means
 * adding a member here — typos in slot names then become compile errors,
 * and IDE autocomplete surfaces the full list at the call site.
 *
 * Each slot doc-comment describes:
 *   - the decision the agent is making when this slot renders
 *   - the kind of fragment that earns its tokens here
 *   - whether the slot is render-conditional (only fires for some
 *     surfaces) or always active
 */
export const PROMPT_SLOTS = {
  // ── cron / delivery ────────────────────────────────────────────────────

  /**
   * One line per registered delivery handler describing its required
   * extras shape and a working example payload. Discord, Slack, webhook
   * plugins each contribute their own. Always active — the agent needs
   * the catalog regardless of the current surface.
   */
  CRON_DELIVERY_HANDLERS: "cron.delivery-handlers",

  /**
   * Render-conditional. The bound channel claims "default delivery target"
   * when the user says "here" without specifying. Only fires when the
   * current turn is rendering for that channel.
   */
  CRON_DELIVERY_DEFAULT: "cron.delivery-default",

  /**
   * Render-conditional. Suggested `tz:` value for cron schedules — for
   * example, the Slack workspace timezone when running inside a Slack-bound
   * session.
   */
  CRON_TIMEZONE_DEFAULT: "cron.timezone-default",

  /**
   * Skills with non-trivial cost / latency claim a min-cadence note here so
   * the agent doesn't schedule them on a tight interval.
   */
  CRON_SKILL_AVAILABILITY: "cron.payload-prompt.skill-availability",

  /**
   * Per-handler "honors `[SILENT]`?" disclosures. Plugins that ignore the
   * silent gate must say so here so the agent doesn't rely on the gate to
   * suppress posts.
   */
  DELIVERY_SILENT_GATE: "delivery.silent-gate-applicability",

  // ── ask_user ───────────────────────────────────────────────────────────

  /**
   * Render-conditional. Channel-specific button caps, label limits,
   * preview / multiSelect support. Drives how many options and what kind
   * of preview the agent emits.
   */
  ASK_USER_CHANNEL_CAPABILITIES: "ask_user.channel-capabilities",

  /**
   * Render-conditional. The bound channel asserts "questions delivered
   * here stay here" so the agent doesn't bounce them to the dashboard.
   */
  ASK_USER_ESCALATION_TARGET: "ask_user.escalation-target",

  /**
   * Render-conditional. How `option.preview` renders in the bound channel
   * (code-block highlighting? plain text? not at all?). Lets the agent
   * pre-format previews for a channel that won't render markdown.
   */
  ASK_USER_PREVIEW_RENDERING: "ask_user.preview-rendering",

  // ── web ────────────────────────────────────────────────────────────────

  /**
   * Domains where `web_fetch` returns a login HTML page silently — and the
   * auth-aware tool to call instead. Plugin authors list their walled
   * domains here so the agent picks the right fetcher up front.
   */
  WEB_FETCH_AUTH_WALLED_DOMAINS: "web_fetch.auth-walled-domains",

  /**
   * Backend cost / quota notes for metered web_search providers. Drives
   * query specificity and frequency.
   */
  WEB_SEARCH_RATE_AND_QUOTA: "web_search.rate-and-quota",

  // ── exec ───────────────────────────────────────────────────────────────

  /**
   * Env-var / cwd warnings from loaded plugins (e.g. "DISCORD_BOT_TOKEN is
   * in process.env — don't echo env in posted output").
   */
  EXEC_ENVIRONMENT_WARNINGS: "exec.environment-warnings",

  // ── subagent ───────────────────────────────────────────────────────────

  /**
   * Plugin-registered alternative subagent runtimes (Claude Code, Codex,
   * Gemini). Plugins describe their runtime's quirks (which fields it
   * accepts, what model selection looks like) so the agent passes the
   * right `runtime`/`model` on `spawn_subagent`.
   */
  SUBAGENT_RUNTIME_AVAILABILITY: "subagent.runtime-availability",

  // ── system prompt ──────────────────────────────────────────────────────

  /**
   * Top-of-prompt warnings (degraded plugin state, missing perms, OAuth
   * expired). Surfaced in the system prompt so the agent pre-empts the
   * failure rather than discovering it via a 4xx mid-task.
   */
  SYSTEM_STARTUP_WARNINGS: "system.startup-warnings",
} as const;

/**
 * Literal union of every legal slot. Plugin SDK uses this to constrain
 * `PluginPromptFragment.slot`; typos and removed slots become compile
 * errors at the call site.
 */
export type PromptSlot = (typeof PROMPT_SLOTS)[keyof typeof PROMPT_SLOTS];
