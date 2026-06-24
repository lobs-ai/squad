# Plugins

Plugins are the extension mechanism. **All** new tools, providers, channels,
skills, routines, subagent definitions, toolset bundles, slash commands, and
delivery handlers go through `definePlugin()`. Resist adding special cases in
the gateway for specific plugins.

## Shape

```
my-plugin/
├── package.json
│   └── "squad": { "entry": "./dist/index.js" }
├── src/
│   └── index.ts   → default export: definePlugin({...})
└── README.md
```

```ts
import { definePlugin } from "@squad/plugin-sdk";

export default definePlugin({
  id: "my-cool-plugin",
  name: "My Cool Plugin",
  version: "0.1.0",
  kinds: ["tool", "subagent"],   // a plugin can be several kinds
  register(api) {
    api.tools.register(new MyCoolTool());
    api.subagents.register({ name: "researcher", ... });
    api.hooks?.on?.("after_tool_call", ({ toolName }) => {
      api.logger.info(`ran ${toolName}`);
    });
    return () => { /* optional cleanup, called on disable/reload */ };
  },
});
```

## Kinds

`PluginKind = "tool" | "provider" | "channel" | "skill" | "routine" | "subagent"`

| Kind       | What it registers                                                                  |
|------------|------------------------------------------------------------------------------------|
| `tool`     | New tools (extend `BaseTool`); appear in the registry, group-able                  |
| `provider` | New `LLMClient` implementations (a vendor not covered by the vendored set)         |
| `channel`  | New channel adapters — Discord-equivalent for Slack/Telegram/SMS/etc.              |
| `skill`    | Parameterized subagent definitions or legacy system-prompt fragments               |
| `routine`  | Cron-scheduled agent runs                                                          |
| `subagent` | A named, reusable subagent definition (model, tools, system prompt, budget)        |

A skill in the modern shape is sugar over `subagent` — the host turns it
into a registered subagent named `skill:<id>` so it's invokable via
`spawn_subagent({ subagent: "skill:research", input: {...} })`.

## GatewayAPI surface

Source of truth: `packages/plugin-sdk/src/types.ts` (`GatewayAPI`).

```ts
api.tools.register(tool)
api.providers.register(name, client)
api.subagents.register(def)
api.subagentRuntimes.register(runtime)   // for non-Squad runtimes (Claude Code, Codex, …)
api.routines.register(def)
api.skills.register(skill)
api.approvalPolicies.register(policy)
api.channels.register(channel)
api.commands.register(cmd)               // slash commands surfaced via commands.list
api.toolsets.register(def)               // curated tool bundles for spawn_subagent
api.delivery.register(kind, handler)     // routine delivery fan-out (e.g. "discord")
api.promptFragments.register(fragment)   // conditional prompt extensions; see below
api.http.register(method, path, handler) // mount HTTP routes (OAuth callbacks, webhooks); needs `http` manifest permission
api.ui.contribute(contribution)          // declarative UI metadata for the dashboard
api.logger / api.config
```

## Conditional prompt fragments

Plugins can extend the descriptions of built-in tools (and the system
prompt) **without** rewriting them. Use this when, without your fragment,
the agent would write a tool call that fails or picks the wrong option —
and the schema can't carry the info. Don't use it to advertise that your
plugin exists; the tool-group index, channel registry, and `plugin_list`
already cover that.

```ts
import { definePlugin, PROMPT_SLOTS } from "@squad/plugin-sdk";

api.promptFragments.register({
  slot: PROMPT_SLOTS.CRON_DELIVERY_HANDLERS,
  content:
    'discord — post into a guild channel. Required: channelId (snowflake). ' +
    'Example: { kind: "discord", channelId: "1234567890123456" }',
});

api.promptFragments.register({
  slot: PROMPT_SLOTS.ASK_USER_CHANNEL_CAPABILITIES,
  content: "Discord buttons cap at 4 options; option labels truncate at 80 chars.",
  // Render-conditional: only fires when this turn is rendering for Discord.
  when: (render) =>
    render.surface === "channel" && render.channelKind === "discord",
});
```

### How it works

- `slot` is one of the canonical `PROMPT_SLOTS.*` constants. Typing a raw
  string fails compilation. New slots land via PR to
  `packages/tools/src/prompt-slots.ts` (the doc-comment on each member
  describes what fragments belong there).
- `content` is plain text the slot's owner-tool inlines into its
  description.
- `when(render, ctx)` is an optional predicate evaluated **at render
  time**. `render` is the per-turn `RenderContext` (surface, channelKind,
  channelId, capabilities, parentSubagent); `ctx` is the live
  `PromptContextSnapshot` (channels, deliveryKinds, plugins, …). Omit
  `when` for fragments that should always fire.
- Fragments are tracked per-plugin and dropped automatically on `unload` /
  `disable`. No restart needed — the next turn re-renders descriptions
  with the new fragment set.

### When to use a fragment

Only when, without it, the agent would write a tool call that fails or
behaves wrong, and the schema can't express the constraint. Each
fragment should change a specific decision the agent is making. If your
fragment reads "btw I also have tool X," it doesn't belong in a fragment —
the tool-group index already handles inventory.

### Render context shape

```ts
interface RenderContext {
  surface: "dashboard" | "cli" | "channel" | "cron-isolated" | "subagent" | "unknown";
  channelKind?: string;        // when surface === "channel": "discord", "slack", ...
  channelId?: string;
  capabilities?: ChannelCapabilities;
  parentSubagent?: string;
}
```

The gateway derives this per-turn from the channel binding for the
session. Threaded through `AsyncLocalStorage` so tool descriptions
(`BaseTool.describe(ctx, render)`) and the fragment `when` predicate
both see the same value within a turn.

### Source

- Slot taxonomy: `packages/tools/src/prompt-slots.ts` (`PROMPT_SLOTS`,
  `PromptSlot`).
- Store + types: `packages/tools/src/prompt-context.ts`.
- Plugin SDK: `PluginPromptFragment` in `packages/plugin-sdk/src/types.ts`;
  re-exported `PROMPT_SLOTS` / `PromptSlot` / `RenderContext` /
  `PromptContextSnapshot` from `packages/plugin-sdk/src/index.ts`.
- Wiring: `gateway/src/index.ts` builds the `PromptContextStore`,
  `gateway/src/runs.ts` wraps `runAgent` in `store.runWithRender(render, …)`.
- Reference plugin: `packages/channel-discord/src/plugin.ts` registers
  seven Discord-specific fragments (some always-on, some
  render-conditional).

## Loading

On startup the gateway:

1. Reads `extensions/` and any paths in `config.json`'s `plugins` list.
2. `import()`s the entry, validates the descriptor.
3. Calls `register(api)` with a scoped `GatewayAPI`.
4. Stores any returned cleanup function for `plugins.disable` / `plugins.reload`.

Plugins are **not sandboxed**. Self-host model — you trust what you install.

## Approval policies

A plugin can ship an `ApprovalPolicy` alongside its tools. The gateway
cascades policies (first non-`escalate` decision wins) and falls through to
the default tag-match policy. Subagents inherit the parent's policy unless
the definition narrows it. Source: `packages/gateway/src/approvals/`.

## When to write a plugin vs. a built-in

Built-in (lives in `packages/`):
- Anything in the v1 core surface (the named tool groups, the four primitives,
  Discord, the dashboard).

Plugin (`extensions/` or external npm package):
- Anything user-specific, anything experimental, anything that adds a new
  channel or a new provider, any new kind of subagent.

The starter examples live in `extensions/example-subagent-plugin` and
`extensions/example-toolset-plugin` — copy from them.

## Source

- Contract: `packages/plugin-sdk/src/types.ts`, `packages/plugin-sdk/src/index.ts`
- Manifest validation: `packages/plugin-sdk/src/manifest.ts`
- Host: `packages/gateway/src/plugins/host.ts`
- SPEC: see `SPEC.md` § "Plugins — Authoring & Loading"
