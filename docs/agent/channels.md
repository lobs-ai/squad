# Channels

A channel is a platform adapter — Discord, Slack, Telegram, SMS, email, voice,
the dashboard's chat view. **Every** channel is a plugin. The gateway has no
hard-coded knowledge of any specific channel; even Discord arrives as a
plugin (it just happens to be loaded in-process by default).

## Two deployment modes

| Mode         | Where it runs                              | When to use                        |
|--------------|--------------------------------------------|------------------------------------|
| In-process   | Same node process as the gateway           | Default — `docker compose up` is one container |
| Out-of-process | Separate node process, talks WS to gateway | Bot crashes shouldn't restart gateway; isolating untrusted code; running many channels |

The Discord package supports both from the same code. Out-of-process mode
uses `@squad/channel-sdk`'s `SquadGatewayClient` to connect via WebSocket;
in-process mode mounts directly against the gateway's stores.

## Lifecycle

```ts
// packages/channel-sdk/src/channel-base.ts
export abstract class Channel {
  abstract readonly id: string;
  abstract readonly capabilities: ChannelCapabilities;
  abstract connect(): Promise<void>;
  abstract disconnect(): Promise<void>;
}
```

A channel plugin registers a `ChannelHandle` (`packages/plugin-sdk/src/types.ts`)
on `api.channels.register({...})` with `id`, `kind`, `label`, capabilities,
and `start` / `stop` lifecycle hooks. The gateway calls `start` after the
HTTP/WS server is listening (so back-connections are safe).

## Capabilities

Every channel declares what it can render:

```ts
{
  supportsPreview: true,        // can show a `preview` block in ask_user
  supportsMultiSelect: true,
  supportsFreeText: true,       // can collect "Other" answer
  maxOptions: 4,
  supportsImages: true,
  supportsFileUploads: true,
  supportsTaskList: true,       // can render the task panel/embed
  supportsApprovals: true,      // can collect approve/deny decisions
}
```

The gateway uses these to **degrade loudly**, not silently. If you call
`ask_user` with 5 options on a channel capped at 4, the tool call is rejected
with a clear error so you can re-shape the question.

## Renderer contract

`packages/channel-sdk/src/renderer.ts`:

```ts
interface ChannelRenderer {
  onAssistantText(sessionId, text, { final })
  onToolCall?(sessionId, toolCallId, name, input)
  onToolResult?(sessionId, toolCallId, result, isError)
  renderTaskList?(sessionId, tasks[])
  handleTaskAction?(taskId, "claim" | "complete" | "delete")
  renderAsk?(sessionId, question)
  renderApproval?(sessionId, approval)
}
```

A channel implements the subset matching its capabilities. Adding task
support to a channel = implement `renderTaskList` + `handleTaskAction`. No
gateway changes.

## Discord (reference channel)

`packages/channel-discord/`:

```
src/
├── channel.ts       # the ChannelHandle / Channel implementation
├── plugin.ts        # default-export definePlugin({ kinds: ["channel"] })
├── bot.ts           # discord.js Client + intents + event wiring
├── standalone.ts    # entrypoint when run as its own process
├── formatting.ts    # markdown, code blocks, 2000-char chunking
├── capabilities.ts  # what Discord can render
├── config.ts        # Zod-validated channel config
└── index.ts
```

By default the plugin is loaded in-process. To run it standalone, use
`examples/compose.split-channels.yml` and the `standalone.ts` entrypoint —
same code, different boundary.

## Channel registry

The gateway's `ChannelRegistry` (`packages/gateway/src/channels/registry.ts`)
holds the live set of registered channels and exposes them via the protocol's
`channels.*` namespace (`list`, `bind`, `unbind`, `capabilities`).

## Adding a new channel

1. Create `packages/channel-<name>/` (or an external npm package).
2. Implement `Channel` from `@squad/channel-sdk` and a `ChannelHandle`.
3. Wrap in a plugin (`kinds: ["channel"]`) and register via
   `api.channels.register(...)`.
4. Implement the parts of the renderer contract you can support, set
   `capabilities` honestly.
5. If your channel has its own routine delivery semantics (e.g. "post to
   #general"), register a delivery handler via `api.delivery.register("slack",
   handler)`. The built-in `silent` and `dashboard` kinds are gateway-owned
   and can't be overridden.

Don't import `discord.js` (or any channel-specific library) into
`packages/gateway`. That rule is load-bearing.

## Source

- SDK: `packages/channel-sdk/src/`
- Discord: `packages/channel-discord/src/`
- Registry: `packages/gateway/src/channels/registry.ts`
- Protocol: `packages/protocol/src/namespaces/channels.ts`
- SPEC: `SPEC.md` § "Discord Implementation Plan" for D0/D1/D2 phasing
