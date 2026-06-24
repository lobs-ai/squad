# Tool groups (lazy loading)

The system prompt has a token budget. Listing every tool's schema on every
turn would burn it. So tools live in **groups**, and only the *default*
groups are loaded on every turn. Lazy groups appear as a one-line index
entry; you unlock them with `describe_tool_group`.

## Default groups (always loaded)

| Group        | Tools                                                              |
|--------------|--------------------------------------------------------------------|
| `filesystem` | `read`, `write`, `edit`, `ls`                                      |
| `search`     | `grep`, `glob`, `find_files`, `code_search`                        |
| `exec`       | `exec` (shell — builds, tests, git, gh)                            |
| `web`        | `web_search`, `web_fetch`                                          |
| `questions`  | `ask_user`                                                         |

These are the tools you *always* have without doing anything.

## Lazy groups (in the index, not in the schema)

| Group              | Tools (high level)                                          |
|--------------------|-------------------------------------------------------------|
| `plugin-management`| install / enable / disable / configure plugins              |
| `env`              | read / set gateway environment + secrets                    |
| `cron`             | manage cron- and webhook-scheduled routines                 |
| `tasks`            | `create_task`, `update_task`, `list_tasks`, `get_task`      |
| `subagents`        | `spawn_subagent`, `create_subagent`, etc.                   |
| `memory`           | propose / update / archive / search memory entries          |
| `config`           | inspect / set gateway config                                |
| `restart`          | restart the gateway (rare; user-initiated)                  |
| `doctor`           | health checks                                               |
| `apps`             | list / inspect registered apps                              |
| `html-to-pdf`      | render HTML to PDF                                          |
| `pptx`             | build PowerPoint presentations                             |

Source of truth: `BUILTIN_GROUPS` in `packages/tools/src/index.ts`.

## How to unlock

```
describe_tool_group({ groups: "tasks" })            // one
describe_tool_group({ groups: ["tasks", "memory"] }) // many at once
```

The tool returns the group's full guidance text **and** marks the group as
unlocked for this session. **The schemas only become callable on the *next*
turn** — this turn you only see the guidance. So unlocking has a one-turn
cost.

If the user asks you to "use all your tools", "show me what you can do", or
otherwise wants every capability online, batch-unlock every group from the
index in one call.

**Don't** tell the user a capability isn't available when its group is in the
index. Unlock it. The cost is one turn; the cost of *not* unlocking is
failing the request.

## Per-session unlocked set

The gateway tracks which lazy groups each session has unlocked
(`SessionStore.getUnlockedGroups`). On every turn `runs.ts` recomputes the
allow-list as `defaults() + unlockedGroups + describe_tool_group`. The set
persists across restarts (it's on the `sessions` row).

## Adding a new tool

1. Implement it in `packages/tools/src/<area>/tools.ts` extending `BaseTool`.
   Set accurate `tags` (`readonly` / `write` / `exec` / `network`) — they
   drive approval policy.
2. If it's a built-in: register it in `BUILTIN_TOOLS` in
   `packages/tools/src/index.ts` and assign it to a `ToolGroup` (or create a
   new group and add it to `BUILTIN_GROUPS`).
3. If it's a plugin tool: register it in the plugin's `register(api)` via
   `api.tools.register(...)`. See [plugins.md](plugins.md).
4. Tests next to the source as `*.test.ts`.

## Adding a new group

Add to `packages/tools/src/<area>/index.ts`:

```ts
export const myGroup: ToolGroup = {
  name: "mything",
  description: "One-line, shown in the index.",
  toolNames: ["my_tool_a", "my_tool_b"],
  guidance: "Multi-paragraph doc returned by describe_tool_group.",
  default: false,        // omit/false to keep it lazy
};
```

Then list it in `BUILTIN_GROUPS` in `packages/tools/src/index.ts`.

## Source

- Group machinery: `packages/tools/src/groups.ts`
- All groups: `packages/tools/src/index.ts` (`BUILTIN_GROUPS`)
- Per-turn allow-list computation: `packages/gateway/src/runs.ts`
- Per-session unlocked set: `packages/gateway/src/db/sessions.ts`
  (`getUnlockedGroups` / `unlockGroup`)
