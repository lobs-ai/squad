---
name: Squad Dashboard — Design
status: draft
companion: SPEC.md, PLAN.md
---

# Squad Dashboard — Design

This document specifies the web dashboard that ships with squad. It
complements `SPEC.md` (which defines the gateway, protocol, and
plugin contract) and `PLAN.md` (which tracks implementation). The
dashboard already exists as `packages/dashboard` in skeletal form —
this doc is the target state, not a greenfield.

The goal: **simplistic but powerful.** One-screen default that a user
can open and understand in five seconds, deep views that an operator
can live in, and UI extension points that let plugins contribute
first-class panels — not just badges in a config table.

A single host can run more than one squad — the `squad mgr` CLI
(`packages/client-cli/src/commands/mgr.ts`) spins up parallel
gateway containers as `squad-<name>` services. The dashboard is
multi-squad-aware from day one: pick a squad, connect, work — or
fan out across all of them.

---

## Principles

1. **The dashboard is just another channel.** It connects to the
   gateway over the same WebSocket protocol Discord and the CLI use.
   No privileged endpoints, no private APIs. If the dashboard can do
   it, a third-party client can too. (`SPEC.md` §"The protocol is
   the product.") This applies per squad — every gateway, including
   parallel ones, exposes the same surface.
2. **Real-time by default, polling nowhere.** The protocol already
   streams `chat.*`, `tasks.*`, `questions.*`, `subagents.*`, and
   `approvals.*` events over WebSocket. The dashboard subscribes;
   it does not poll. This is the single biggest departure from
   hermes-agent, which polls at 5s and feels stale by comparison.
3. **One overview, then lanes.** The landing page is a single scan
   that answers "what's happening right now?" Everything else is a
   focused deep-view reachable in one click. Avoid openclaw's 17-tab
   top-level; group by role, not by feature.
4. **Plugins contribute UI, not just tools.** A channel or skill
   plugin can register nav tabs, overview widgets, session panels,
   and custom renderers for its own message/tool types. The plugin
   UI surface is the difference between "dashboard" and "platform."
5. **Design tokens all the way down.** No hardcoded colors in
   components, no bespoke CSS per view. Themes swap by changing CSS
   variables at `:root`, never by rebuilding.
6. **Small, composed views — never a god render.** openclaw's
   100KB `app-render.ts` is the anti-pattern. Each view is its own
   file; each widget is its own component; shared state lives in
   typed stores, not on the root element.
7. **Multi-squad is the default mental model.** The dashboard is
   built around N squads, not 1. Even a user with a single squad
   sees a UI that's ready to grow — adding a second squad does not
   change shape, only count.

---

## Multi-squad: the squad manager

A single host can run any number of independent squads side by
side. Each is a separate gateway process inside its own
`squad-<name>` docker compose service on its own host port, with
its own config, its own `.env`, its own SQLite, its own plugin
set. They do not share state. They do share a host registry and
a generated compose file.

**Source of truth (the manager):**

- `~/.squad/squads.json` — registry: `{ name, port }[]` + shared
  resource ports. Hand-edit-safe.
- `~/.squad/docker-compose.yml` — generated; never hand-edit.
  `squad mgr regen` rewrites it from `squads.json`.
- `~/.squad/squads/<name>/` — per-squad config, env, data dir.
- `~/.squad/current` — pointer to the active squad for CLI
  commands.
- Docker labels (`lobs.squad.name`, `lobs.squad.port`) are baked
  into the running containers; the manager treats labels as the
  runtime source of truth and the registry as the desired state.

`squad mgr` covers create / rm / ls / start / stop / restart /
logs / use / regen / import / exec — see
`packages/client-cli/src/commands/mgr.ts:558` for the help text.

### What this means for the dashboard

A few things the dashboard has to do that a single-squad UI does
not:

1. **Know about more than one gateway.** The connection layer is
   keyed by squad name, not by URL. Each squad has its own URL,
   its own bearer token, its own plugin manifest, its own session
   state.
2. **Let the user switch.** Picking a squad is a top-level UI
   action — not buried in settings. The active squad is shown in
   the status bar at all times.
3. **Aggregate when useful.** Pending questions, approvals, and
   running subagents make sense as a per-squad metric *and* as
   a cross-squad total. The Manager Overview (below) shows both.
4. **Treat plugins as per-squad.** Squad A and squad B can have
   completely different plugins enabled. Plugin UI manifests are
   loaded from the active squad's gateway and re-loaded on
   switch — the SDK surface stays the same, the contributions
   differ.
5. **Survive squads going up and down.** A squad in a `restart`
   loop should show as unhealthy, not crash the dashboard. The
   per-squad WebSocket lives behind a circuit breaker.

### Two deployment shapes

The dashboard is the same SPA in both:

**A. Per-squad dashboard (the default).** Each squad's gateway
serves the dashboard at `/`. Open `http://host:<port>/` and you
land on that squad. The squad switcher discovers siblings via
the gateway's new `admin.peers()` method (see Protocol additions)
and connects directly to each peer over WebSocket as you switch.
This is the simplest path — one image, one binary, every squad
self-serves.

**B. Manager-only dashboard (optional).** A user who runs many
squads may not want any one of them privileged as "the host."
The same SPA can be served standalone by the `squad mgr` CLI
on a fixed port (e.g., `squad mgr ui --port 9090`), reading the
local `~/.squad/squads.json` and live docker labels to populate
the squad list. Connections still go directly to each squad's
gateway WebSocket. This mode is read-mostly w/r/t the manager
itself — squad lifecycle (`start`/`stop`/`create`) stays in the
CLI for v1; the UI shows status and offers shell-out hints.

Both shapes use identical code; only the squad-discovery source
differs (gateway peer list vs. local registry + docker).

### Protocol additions

To support shape A without a sidecar, the gateway grows a small
admin surface:

| Method                  | Returns                                               |
|-------------------------|-------------------------------------------------------|
| `admin.identity()`      | `{ name, port, build, started_at }` for *this* squad  |
| `admin.peers()`         | `[{ name, url, status }]` for sibling squads (best-effort, label-derived) |
| `admin.peers.subscribe` | Emits `peers.changed` when a sibling appears/leaves   |

`peers()` is best-effort: a gateway running outside docker, or
without read access to the docker socket, returns just itself.
The dashboard treats an empty peer list as "single-squad mode"
and hides the switcher chrome rather than showing an empty list.

---

## Tech stack

Inherited from the existing `packages/dashboard` and chosen to match
patterns squad already uses elsewhere.

- **React 18 + TypeScript + Vite.** Already in place. No migration.
- **Tailwind CSS 4** for utility styling, with a thin `tokens.css`
  layer defining semantic variables (`--bg`, `--bg-elevated`,
  `--fg`, `--accent`, `--ok`, `--warn`, `--danger`, `--info`,
  spacing, radius, shadow). Tailwind consumes the tokens; plugins
  read the same tokens.
- **shadcn/ui primitives** copied into `packages/dashboard/src/ui/`
  (Button, Card, Dialog, Tabs, Input, Select, Badge, Toast,
  Command). Owned in-tree so we can version-pin and export them to
  plugins.
- **Lucide icons** — one icon set, referenced by string name so
  plugin manifests can declare icons without shipping SVGs.
- **Zustand** for client state (connection, current session,
  subscriptions). Not Redux. Not context-per-slice. One store per
  domain, composed.
- **WebSocket transport** via the existing
  `packages/dashboard/src/protocol-client.ts` (`BrowserProtocolClient`).
  Shared with any third-party web client.

Explicit non-choices:
- **No Next.js.** The dashboard is an SPA served at `/` by the
  gateway. Routing is React Router, nothing more.
- **No React Query / SWR.** The protocol is push-based; a fetch
  cache is the wrong abstraction. A thin `useSubscription(topic)`
  hook is the right one.
- **No chart library up front.** Recharts or Observable Plot can
  land when analytics ships; not on the critical path for v1.

---

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ [squad ▾ default]  Overview · Chat · Tasks · Sessions · ⚙     │
├────────────┬────────────────────────────────────────────────────┤
│            │                                                    │
│  Session   │                                                    │
│  sidebar   │              Main view                             │
│            │                                                    │
│  (active   │                                                    │
│   + recent)│                                                    │
│            │                                                    │
│            │                                                    │
├────────────┴────────────────────────────────────────────────────┤
│ ◉ default · :8080 · build a3f1 · approvals (2) · skin ▾        │
└─────────────────────────────────────────────────────────────────┘
```

- **Squad picker (top-left).** Click to open a dropdown of all
  known squads with health dot + port; the bottom of the menu
  links to `/manager` (Manager Overview) and `/manager/new`
  (which opens the create-squad guide). Single-squad installs
  show the squad name as static text — the dropdown is suppressed
  unless `admin.peers()` returns peers.
- **Top nav:** core tabs plus any plugin-registered tabs. Position-
  aware (see Plugin UI §"Nav contribution"). Tabs are scoped to
  the active squad — switching squads keeps the tab but reloads
  the squad-specific data.
- **Left sidebar:** session switcher. Always visible. Shows active
  sessions (with a pulse if streaming), then recent. Collapsible on
  mobile.
- **Main view:** whatever tab is selected. Each view owns its
  subscriptions; none bleed into the root.
- **Status bar:** active squad name + port + health, gateway build
  hash, pending approvals count (clickable → approvals drawer for
  the active squad), skin picker.

The sidebar + status bar are persistent; everything else replaces
on navigation. Ctrl/Cmd-K opens a global command palette
(shadcn's Command primitive) for fast session/tab switching.

---

## Default view: Overview (per-squad)

The landing page **for the active squad.** One screen. Answers
"what's this squad doing, what does it need, what just happened?"
The Manager Overview (next section) is a separate, optional
landing for users with several squads.

```
┌────────────────────────────────────────────────────────────────┐
│  Overview                                                      │
├──────────────────────────┬─────────────────────────────────────┤
│                          │                                     │
│  Active work             │  Needs you                          │
│  ─ 2 sessions streaming  │  ─ 1 question (15s ago)             │
│  ─ 3 subagents running   │  ─ 2 approvals pending              │
│  ─ 7 tasks in-progress   │   [answer] [review]                 │
│                          │                                     │
├──────────────────────────┼─────────────────────────────────────┤
│                          │                                     │
│  Recent activity          │  Shared task list                  │
│  [streaming event feed]  │  [top 5 in-progress tasks,          │
│  ─ task #42 completed     │   click to jump to session]        │
│  ─ subagent spawned       │                                     │
│  ─ tool: read src/...     │                                     │
│                          │                                     │
├──────────────────────────┴─────────────────────────────────────┤
│  Plugin widgets  [registered by plugins — see below]           │
└────────────────────────────────────────────────────────────────┘
```

Four built-in widgets: **Active work**, **Needs you**, **Recent
activity**, **Shared task list.** Each is a subscription on a
specific topic:

| Widget           | Topics subscribed                                |
|------------------|--------------------------------------------------|
| Active work      | `session.*`, `subagents.*`                       |
| Needs you        | `questions.asked`, `approvals.pending`           |
| Recent activity  | `chat.*/*` (filtered to high-signal event kinds) |
| Shared task list | `tasks.*/*` (aggregated across sessions)         |

**Needs you** is the hero. openclaw and hermes both bury pending
questions and approvals in sub-tabs; squad's ask-user and approvals
primitives only pay off if acting on them is the fastest path on
the page.

Plugin widgets render below the built-ins, in a grid, in registration
order (modifiable by the user — see Plugin UI §"Overview widget").

---

## Manager Overview (`/manager`)

Multi-squad landing page. Shown by default when the active install
has more than one squad. A user with one squad can still reach it
through the squad picker dropdown — useful when about to add a
second.

```
┌────────────────────────────────────────────────────────────────┐
│  Squads (3)                              [+ new squad]         │
├────────────────────────────────────────────────────────────────┤
│  ◉ default  :8080  healthy   2 sessions  1 question  → enter   │
│  ◉ work     :8081  healthy   0 sessions                → enter │
│  ◌ scratch  :8082  stopped              [start] [logs]         │
├────────────────────────────────────────────────────────────────┤
│  Cross-squad needs you                                         │
│  ─ default: "Pick a branch?" (30s ago)                         │
│  ─ work: 1 approval pending                                    │
├────────────────────────────────────────────────────────────────┤
│  Cross-squad activity feed                                     │
│  [merged stream from every connected gateway]                  │
└────────────────────────────────────────────────────────────────┘
```

Per row: health dot (healthy / unhealthy / starting / stopped),
name, port, session + pending counters, primary action ("enter" →
switches active squad and routes to that squad's Overview).
Stopped squads show `start` / `logs` hints; v1 shells out to the
CLI rather than starting them in-browser. Subsequent versions can
add an `admin.lifecycle()` method on the manager-mode UI for
one-click start/stop, but only behind opt-in trust.

The Manager Overview opens one persistent WebSocket per squad —
each one a normal protocol client, just multiplexed into a
shared store. Squads that fail to connect render in a degraded
state with a retry button; they don't block the rest of the page.

---

## Deep views

Each is a single purpose, deep-linkable, owns its subscriptions.

### Chat (`/sessions/:id`)
Already exists in skeletal form. The full version:
- **Left column:** session tree (parent + subagent children).
  Click to switch the main pane.
- **Main column:** message stream with streaming text, tool calls
  (collapsible, with inputs + outputs), pending question card
  (Discord-buttons-but-on-the-web), pending approval banner.
- **Right column (collapsible):** session-scoped task list +
  session metadata (model, tools enabled, token budget, cost).
- **Composer:** message input with `/command` palette, attachment
  support, "ask as subagent" dropdown (start a fresh child with
  a pre-registered subagent definition).

Tool calls and message parts are rendered via a registry — plugins
can register renderers for their tool types (see Plugin UI
§"Message/tool renderers").

### Tasks (`/tasks`)
Cross-session task board. Columns: `pending`, `in_progress`,
`blocked`, `completed`. Filter by session, assignee (agent vs
subagent vs user), tag. Click a task to open its originating
session at the message that created it.

### Sessions (`/sessions`)
List + search. FTS over session content (hermes does this well;
steal the pattern but keep it live-updating, not paginated polling).
Filter by channel (discord / dashboard / cli / plugin:xxx), by
time, by cost bucket. Bulk actions: archive, export, delete.

### Plugins (`/plugins`)
One row per installed plugin **for the active squad.** Status
(enabled/disabled, healthy/erroring), kinds (`tool`, `provider`,
`channel`, `skill`, `routine`, `subagent`, `ui`), source (builtin
/ workspace / npm / local path), config (expandable schema-driven
form). Plugin rows can be the **entry point** for plugin-owned
detail pages (a channel plugin's "Discord" tab surfaces here for
deeper configuration). Two squads with different plugin sets show
different rows; this is intentional.

### Settings (`/settings`)
Gateway config for the active squad (YAML + schema-driven form
side by side, hermes pattern), model catalog (from
`admin.models()`), API keys (write-only, never read back), theme,
keyboard shortcuts. A small **Manager** section at the top lists
all known squads and their host ports — a read-only mirror of
`~/.squad/squads.json` when running in manager mode, or of
`admin.peers()` otherwise. Lifecycle (create / rm / start / stop)
points to the CLI in v1. Resist the openclaw urge to fan this
out into eight sub-tabs.

---

## Plugin UI contract

This is the feature that most distinguishes squad's dashboard from
openclaw (plugins can't contribute UI at all) and hermes (plugins
can only register tabs). Squad's plugins are first-class UI
contributors at five extension points.

### 1. Declaration

A plugin declares its UI contribution in its `definePlugin()`
manifest. The `ui` block is optional; server-only plugins (a tool, a
provider) don't need it.

```ts
definePlugin({
  id: "my-plugin",
  name: "My Plugin",
  version: "1.0.0",
  kinds: ["tool", "ui"],
  register(api) {
    api.tools.register(...)
  },
  ui: {
    // One bundle, served by the gateway from the plugin dir.
    entry: "ui/index.js",
    css: "ui/styles.css",
    // Contributions declared upfront so the dashboard can lay
    // out nav / widget slots before the bundle finishes loading.
    contributions: {
      navTab: {
        path: "/my-plugin",
        label: "My Plugin",
        icon: "Sparkles",
        position: "after:tasks",
      },
      overviewWidgets: [
        { id: "my-plugin:queue-depth", size: "small" },
      ],
      sessionPanels: [
        { id: "my-plugin:inspector", label: "Inspector" },
      ],
      toolRenderers: ["my_plugin.search", "my_plugin.write"],
    },
  },
})
```

The gateway aggregates all `ui` contributions and serves them at
`GET /api/plugins/ui` as a manifest. Plugin static assets are
served from `GET /api/plugins/:id/ui/*`.

### 2. Loading

At startup, **and again every time the active squad changes**, the
dashboard:
1. Fetches `<squad>/api/plugins/ui` → list of contribution
   manifests for that squad.
2. Tears down slots from the previous squad's plugins (unmounts
   components, removes their stylesheets, frees their
   subscriptions).
3. Renders nav slots, widget slots, panel slots from the new
   manifests (showing skeletons where bundles haven't loaded
   yet).
4. Injects `<link rel="stylesheet">` for any declared CSS,
   namespaced by squad name to avoid leakage across switches.
5. Loads each `entry` as `<script type="module" async>`. Bundle
   URLs include the squad name so the same plugin id from
   different squads doesn't share a script-tag cache slot.
6. Each plugin module calls `window.__SQUAD_UI__.register(...)`
   to attach components to the declared slots — the SDK routes
   them to the currently active squad's slot tree.

Loading failures are contained: one plugin's broken bundle
downgrades its slots to an error badge; the rest of the
dashboard, and the rest of the squads, stays up.

### 3. Contribution points

| Slot              | What it renders                              | Default location                |
|-------------------|----------------------------------------------|---------------------------------|
| **Nav tab**       | A top-nav entry + route at `/plugin/:id`     | Top nav, positioned             |
| **Overview widget** | A card on the Overview page               | Overview, plugin grid           |
| **Session panel** | A tab inside the session right-column        | Chat view, right column         |
| **Tool renderer** | Replaces default renderer for a tool id       | Inside chat message stream      |
| **Quick action**  | A command palette entry (Cmd-K)              | Global command palette          |

All contributions are **slot-based, declarative, and positioned.**
Nav tabs accept `before:<id>`, `after:<id>`, or `end` positions
(hermes's pattern — keep it). Widgets declare a size hint
(`small` / `medium` / `wide`); the grid handles layout.

### 4. Plugin SDK surface

Exposed on `window.__SQUAD_UI__` at dashboard boot, before any
plugin bundle loads:

```ts
interface SquadUI {
  // Component registration.
  register: {
    navTab(id: string, component: FC): void
    overviewWidget(id: string, component: FC): void
    sessionPanel(id: string, component: FC<{ sessionId: string }>): void
    toolRenderer(toolId: string, component: FC<ToolCallProps>): void
    quickAction(id: string, action: QuickActionDef): void
  }

  // Typed protocol client for the squad this plugin was loaded
  // from — not for any sibling squad. The SDK injects the right
  // client at register time so a plugin written for one squad
  // can't accidentally reach into another's state.
  protocol: BrowserProtocolClient

  // Hooks plugins should use for live data. Never fetch-and-cache.
  // All hooks are bound to the plugin's owning squad.
  useSubscription<T>(topic: string): T[]
  useSession(id: string): SessionState
  useTasks(sessionId?: string): Task[]

  // The plugin's owning squad — useful for label/title strings
  // and for logging. Read-only.
  squad: { name: string; url: string }

  // Shared UI primitives (shadcn components + icons).
  components: { Card, Button, Badge, Input, Select, Tabs, Dialog, ... }
  icons: Record<string, IconComponent>

  // Theme tokens as JS-accessible object for rare inline-style cases.
  tokens: ThemeTokens

  // React itself, re-exported so plugins don't bundle their own copy
  // and bloat the dashboard by 40KB per plugin.
  React: typeof React
}
```

**Critical constraint:** plugins never bundle React, Tailwind, or
shadcn. They import from the SDK surface. This keeps plugin bundles
under 10KB for typical cases and prevents version skew.

### 5. Security and isolation

- **v1: same-origin trust.** Plugin bundles run in the main
  dashboard context. Users install plugins deliberately; we don't
  pretend they're sandboxed from each other. This matches squad's
  "self-hosted, your machine" posture.
- **v2 hardening path:** iframe-isolated plugin surface with a
  `postMessage` proxy for the SDK. Opt-in via
  `ui.isolation: "iframe"` in the manifest. The SDK surface
  already looks like an RPC layer, so this is a migration, not a
  redesign.
- **CSP:** the gateway emits a strict CSP for `/`; plugin bundles
  are served from the same origin so they inherit it.

---

## Design tokens and theming

All visual values come from CSS variables on `:root`. No hex
literals in components. No Tailwind arbitrary values unless they
reference a token.

```css
:root {
  /* Surfaces */
  --bg:          #0a0a0a;
  --bg-elevated: #141414;
  --bg-card:     #1a1a1a;
  --fg:          #e8e8e8;
  --fg-muted:    #999;
  --border:      #2a2a2a;

  /* Brand + semantic */
  --accent:  #5b8def;   /* squad blue */
  --ok:      #22c55e;
  --warn:    #f59e0b;
  --danger:  #ef4444;
  --info:    #3b82f6;

  /* Scale */
  --radius:   8px;
  --shadow-1: 0 1px 2px rgba(0,0,0,.4);

  /* Typography */
  --font-ui:   'Inter', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, monospace;
}

[data-theme="light"] { /* inverted tokens */ }
```

Theme switching: `document.documentElement.dataset.theme = "light"`,
no rebuild, no flash. Theme preference persists in localStorage and
is applied before first paint via an inline script in `index.html`
(openclaw's pattern — this is the right one).

Three shipped themes: `dark` (default), `light`, `hi-contrast`.
Plugins read the same tokens, so a plugin widget automatically
matches the active theme with no work.

---

## State management

Four Zustand stores. No global context objects, no prop drilling,
no Redux.

- **`useFleet`** — the set of known squads and the active squad
  pointer. Loads from `admin.peers()` (per-squad mode) or from
  `~/.squad/squads.json` + docker labels (manager mode). Drives
  the squad picker and the Manager Overview.
- **`useConnection`** — keyed by squad name. One WebSocket per
  squad we're talking to (always at least the active squad; up
  to N when the Manager Overview is open). Auth token, gateway
  metadata, circuit-breaker state per entry.
- **`useSessions`** — session list + active session id +
  per-session message buffers, partitioned by squad. Switching
  squads swaps the visible partition; subscriptions write into
  the partition matching their connection.
- **`useLive`** — composite selectors over protocol subscriptions
  for tasks, questions, approvals, subagent status. Read either
  scoped to the active squad (per-squad views) or aggregated
  across all connected squads (Manager Overview).

Plugins do not get direct store access. They go through
`__SQUAD_UI__.useSubscription()` etc. — a thin read-only wrapper
bound to the plugin's owning squad. This keeps the plugin
contract stable even if internal stores change, and keeps a
plugin from a third-party squad from seeing your work squad's
data.

---

## File layout

Extending the existing `packages/dashboard`:

```
packages/dashboard/
  src/
    main.tsx                # existing — entry
    App.tsx                 # existing — refactor: lift views out, add router
    protocol-client.ts      # existing
    tokens.css              # NEW — design tokens
    styles.css              # existing — trimmed down
    routes.tsx              # NEW — React Router config
    ui/                     # NEW — shadcn primitives (owned in-tree)
      button.tsx
      card.tsx
      ...
    stores/
      fleet.ts              # NEW — known squads, active squad
      connection.ts         # keyed by squad name
      sessions.ts           # partitioned by squad
      live.ts
    hooks/
      useSubscription.ts
      useSession.ts
      useTasks.ts
    views/
      Overview.tsx          # NEW — per-squad landing
      ManagerOverview.tsx   # NEW — multi-squad landing (/manager)
      Chat.tsx              # existing — expand
      Tasks.tsx             # existing — expand
      Sessions.tsx          # existing — expand
      Plugins.tsx           # NEW
      Settings.tsx          # NEW
    fleet/                  # NEW — squad picker + discovery
      SquadPicker.tsx
      discovery.ts          # admin.peers() + manager-mode loader
    widgets/                # NEW — overview widgets
      ActiveWork.tsx
      NeedsYou.tsx
      RecentActivity.tsx
      SharedTaskList.tsx
    plugins/                # NEW — plugin UI loader
      loader.ts             # fetches manifest, injects bundles
      sdk.ts                # builds window.__SQUAD_UI__
      slots.tsx             # NavSlot, WidgetSlot, etc.
      types.ts              # plugin UI manifest types
    theme/
      tokens.ts             # JS-side token mirror for SDK
      provider.tsx          # theme data attribute + persistence
```

`packages/plugin-sdk` gains a `ui` export so plugin authors get
types + the `SquadUI` interface definition:

```
packages/plugin-sdk/
  src/
    types.ts        # existing
    ui.ts           # NEW — ui contribution types, SquadUI interface
    index.ts
```

---

## Build order

Phased, each phase demoable. Every phase lands behind no flag —
the dashboard is always shippable.

**Phase D0 — Foundation (1–2d).**
Tailwind + tokens.css, shadcn primitives in `ui/`, router, theme
provider. Move existing `App.tsx` onto the new structure without
adding features. Existing Chat/Tasks/Sessions keep working.

**Phase D1 — Overview (2d).**
Build the default landing page. Four built-in widgets, all driven
by real subscriptions. Status bar. Sidebar session switcher.
Command palette.

**Phase D2 — Multi-squad (2d).**
Add `admin.identity()` and `admin.peers()` to the gateway.
`useFleet` store. Squad picker in the top nav. Connection store
keyed by squad. Per-squad partition in `useSessions`. Manager
Overview at `/manager`. Verify: open two squads via `squad mgr`,
switch in the UI, confirm sessions/tasks/plugins all swap
correctly. This phase intentionally precedes plugin UI — the
plugin loader needs to know how to scope to a squad before it
ships.

**Phase D3 — Expand deep views (2–3d).**
Chat: tool call rendering, pending question card, approval banner,
subagent tree. Tasks: kanban columns, cross-session view.
Sessions: live-updating search.

**Phase D4 — Plugin UI v1 (3d).**
Plugin manifest endpoint, loader (per-squad scoped), SDK surface
on window, slot components, at minimum `navTab` and
`overviewWidget` contributions. Ship one reference plugin (a
simple one exercising both slots) and land its bundle in
`examples/`. Verify it loads correctly under squad switch.

**Phase D5 — Plugin UI full (2d).**
`sessionPanel`, `toolRenderer`, `quickAction`. Update
`channel-discord` to register a Discord-specific session panel
showing server/channel context when the session originated there.

**Phase D6 — Polish (ongoing).**
Keyboard shortcuts, accessibility audit, mobile layout, light
theme tuning, error boundaries around plugin slots and around
each squad's connection, analytics (only once there's a concrete
need).

**Total critical path to feature-complete:** ~12 working days.

---

## What we are explicitly not building

- **A chat UI for end users.** The dashboard is the operator
  surface; end users chat from Discord / Slack / etc. A web chat
  channel can land later as a plugin.
- **An auth system.** The gateway handles tokens; the dashboard
  prompts for one and stores it (per squad — switching squads
  uses a different token). No SSO, no user management in v1.
- **In-browser squad lifecycle.** Creating, removing, starting,
  and stopping squads stays in the `squad mgr` CLI for v1. The
  Manager Overview shows status and copy-pasteable commands.
  Wiring lifecycle into the UI requires a trusted control plane
  (the manager binary itself), and that is a v2 design.
- **A plugin marketplace.** Plugins are installed via config and
  the filesystem, per squad. A registry is a v2 concern.
- **Observability / metrics dashboards.** Tokens-per-day charts
  look great in screenshots and get ignored in practice. Add
  when a user asks.
- **Mobile-first design.** Responsive enough to triage on a phone,
  but the operator workflow is desktop.

---

## Open questions

1. **Plugin UI isolation in v1.** Accepting same-origin trust is
   the pragmatic call, but we should revisit if we ever ship a
   third-party plugin registry.
2. **State sync across tabs.** If a user opens two dashboard tabs
   to the same gateway, do they share a connection via
   `BroadcastChannel`, or each hold their own? Probably each —
   simpler, and the gateway handles dedup. But worth deciding
   before D1.
3. **Tool renderer priority.** If two plugins register a renderer
   for the same tool id, who wins? Proposed: last-loaded wins,
   with a console warning. Simple beats clever here.
4. **Offline / reconnect UX.** Show a banner and retry with
   exponential backoff. Queue user actions? Probably not in v1;
   surface the disconnect clearly and let the user retry.
5. **Squad discovery in manager mode.** Reading
   `~/.squad/squads.json` works when the SPA is served by the
   manager binary on the same host. For a remote manager UI we
   need a small HTTP surface on the manager itself — out of v1
   scope but worth pre-thinking the shape so we don't paint
   ourselves in. Likely shape: the manager exposes `GET /fleet`
   returning the same registry view + per-squad
   reachability.
6. **Token storage across squads.** localStorage keyed by squad
   name is the simple call. Anything stronger (OS keychain,
   per-tab session storage) is opt-in via a setting. Decide
   before D2.
7. **Cross-squad subagent spawn.** Out of scope; squads are
   independent. If a v2 use case appears (one squad delegating
   to another), it lives at the protocol layer, not the UI.

These don't block D0–D4. Settle them before the relevant phase.
