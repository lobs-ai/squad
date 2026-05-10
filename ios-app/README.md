# Squad Mobile (iOS)

iOS companion app for the [Squad](../README.md) agent platform.
Stream sessions live, answer ask-user questions, approve tool calls, browse
tasks, and spawn new work — all wired into the squad gateway running on your
dev box.

## What's here

The app is a SwiftUI iOS app built directly against the squad gateway's
WebSocket protocol (the same wire the dashboard speaks). Layout and tokens are
ported pixel-for-pixel from the design bundle in `squad-mobile/project/`.

```
ios-app/
├── project.yml                     # xcodegen spec — regenerates SquadMobile.xcodeproj
├── SquadMobile.xcodeproj/          # generated; do not hand-edit
└── SquadMobile/
    ├── App/                        # @main, AppState (paired squads + caches)
    ├── Networking/                 # SquadClient (WS+RPC), Keychain, ProtocolTypes
    ├── Design/                     # Tokens, Components (CardView, Pill, Pulse…)
    ├── Onboarding/                 # 5 steps: Welcome → Reach → Connect → Notifs → Done
    ├── Screens/                    # Home, Sessions, Chat, Tasks, Approvals, More + sheets
    └── Resources/                  # Info.plist, asset catalog
```

## Build

The `scripts/dev` script wraps the common flows. From `ios-app/`:

```bash
scripts/dev                          # build + install + launch (default)
scripts/dev build                    # just compile
scripts/dev run                      # install + launch the prebuilt app
scripts/dev logs                     # stream the app's logs
scripts/dev screenshot               # save a PNG to /tmp
scripts/dev reset && scripts/dev     # wipe state and re-run onboarding
scripts/dev xcode                    # open the project in Xcode
scripts/dev doctor                   # print resolved tools / sim id
scripts/dev help                     # full list

SIM='iPhone Air' scripts/dev         # override the simulator
```

Minimum iOS 17. SF Pro and SF Mono stand in for Inter and JetBrains Mono — the
visual rhythm matches without dragging in font binaries.

## How it talks to a squad

On first launch the app shows onboarding:

1. **Welcome** — what the app does
2. **Reach** — Tailscale (recommended) / LAN / cloud tunnel, with copy-pastable
   commands and example URLs
3. **Connect** — the user types the squad URL, the app calls `POST /pair/begin`
   to ask the gateway for a 5–10 char code, displays it, and starts polling
   `GET /pair/poll?code=…`. The user runs `squad pair browser <code>` on their
   dev box; once approved, the poll returns the bearer token, which we store
   in the iOS Keychain.
4. **Notifications** — requests UNUserNotificationCenter permission
5. **Done** — confirms the connection and switches into the tabbed app

After pairing, the app opens a single WebSocket to `<url>/ws?token=<token>`,
subscribes to broadcast topics (sessions, tasks, questions, approvals,
peers.changed), and refreshes its caches whenever an event lands.

## Tabs

- **Home** — pending questions hero card (tap an option to answer via
  `questions.answer`), pending approvals row, live counters, recent sessions
- **Sessions** — list of top-level sessions with channel chip, ID, model,
  streaming pulse; tapping opens chat
- **Tasks** — segmented by status (pending / in_progress / blocked / completed),
  fans out across active sessions and merges the lists
- **Approvals** — swipeable cards (right approve, left deny) calling
  `approvals.decide`
- **More** — search, squad health (`admin.peers`), notifications hub, plus
  account controls (forget squad, reset everything)

The squad pill in the topbar opens a switcher sheet for paired squads. The "+"
FAB on Home/Sessions opens the spawn sheet, which uses `subagents.list` and
`admin.models` to populate the picker, then calls `subagents.spawn` (under an
existing root) or `session.start` + `chat.send` (fresh top-level).

## Live chat

`ChatView` subscribes to per-session topics:

- `chat.text_delta/<sessionId>` — streaming token deltas
- `chat.assistant_message/<sessionId>` — final assistant message
- `chat.user_message/<sessionId>` — new user message (echo)
- `chat.tool_call/<sessionId>` — synthesised into tool bubbles immediately
- `chat.tool_result/<sessionId>` — paired with the matching call
- `chat.error/<sessionId>` — surfaced via `state.lastError`

Tool bubbles get write/exec/net colored tags based on the tool name. Pending
approvals on the active session render an inline banner that jumps to the
approvals tab.

## What's intentionally not here

- No mock data anywhere — every screen reads from the gateway. If your squad
  has no sessions/tasks/etc, the screens show empty states.
- No multi-user concept (the gateway doesn't have one in v1).
- "All squads" mode is a UI affordance only — full multi-gateway aggregation
  isn't wired yet (one connection at a time).
- Push notifications request permission but don't subscribe to a remote
  notification service — the gateway has no APNs registry yet.

## Wire reference

See `SquadMobile/Networking/SquadClient.swift` — every RPC call is mapped to a
small typed wrapper. The frame model and event topics mirror what's defined in
`packages/protocol/src/namespaces/*.ts` and consumed by
`packages/dashboard/src/protocol-client.ts`.
