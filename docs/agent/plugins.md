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
api.ui.contribute(contribution)          // declarative UI metadata for the dashboard
api.logger / api.config
```

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
