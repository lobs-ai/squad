# Wire protocol

JSON-over-WebSocket, validated with Zod on both sides. Every wire message has
a Zod schema in `packages/protocol/src/namespaces/`. **If it isn't there, it
doesn't exist** — adding a method is "schema first, handler second."

## Frame types

`packages/protocol/src/frames.ts`:

```ts
// Client → gateway
{ type: "request", id: "<uuid>", method: "chat.send", params: { ... } }

// Gateway → client (success)
{ type: "response", id: "<request-id>", ok: true, result: { ... } }

// Gateway → client (error)
{ type: "response", id: "<request-id>", ok: false,
  error: { code, message, details? } }

// Gateway → subscribed clients (push)
{ type: "event", topic: "chat.assistant_message", data: { ... } }

// Client → gateway
{ type: "subscribe",   id: "<uuid>", topics: ["chat.*/session-123"] }
{ type: "unsubscribe", id: "<uuid>", topics: [...] }
```

Every method's `params` and `result` are typed via `methodRegistry` in
`packages/protocol/src/namespaces/index.ts`. The dispatcher
(`packages/gateway/src/dispatch/index.ts`) parses the request against the
registered schema, checks the grant's authorisation, then hands typed params
to the handler.

## Namespaces (v1)

| Namespace     | Purpose                                                                   |
|---------------|---------------------------------------------------------------------------|
| `session.*`   | start, resume, end, list, search                                          |
| `chat.*`      | send (user message), stream (server push), history                        |
| `subagents.*` | list defs, spawn, cancel, tree, history                                   |
| `tasks.*`     | create, update, get, list, claim, watch                                   |
| `questions.*` | ask, answer, cancel, list (pending), history                              |
| `approvals.*` | list, decide                                                              |
| `plugins.*`   | list, enable, disable, reload, configure                                  |
| `channels.*`  | list, bind / unbind, capabilities                                         |
| `routines.*`  | list, create, update, delete, run_now                                     |
| `admin.*`     | health, config, tokens.create, tokens.revoke                              |
| `commands.*`  | list slash commands contributed by plugins                                |
| `toolsets.*`  | list, resolve toolset bundles                                             |

Source list: `packages/protocol/src/namespaces/index.ts`. Each namespace is
its own file in that directory; reading `tasks.ts`, `subagents.ts`, etc. is
how you discover the exact param/result shapes.

## Events (broadcast topics)

| Family       | Examples                                                                   |
|--------------|----------------------------------------------------------------------------|
| Chat         | `chat.user_message`, `chat.assistant_message`, `chat.text_delta`, `chat.tool_call`, `chat.tool_result` |
| Subagents    | `subagents.spawned`, `subagents.text_delta`, `subagents.tool_call`, `subagents.tool_result`, `subagents.completed`, `subagents.failed` |
| Tasks        | `tasks.created`, `tasks.updated`, `tasks.deleted`                          |
| Questions    | `questions.asked`, `questions.answered`, `questions.cancelled`, `questions.timed_out` |
| Approvals    | `approvals.pending`, `approvals.decided`                                   |
| Platform     | `plugins.changed`, `routines.fired`, `log.line`, `context.injected`        |

Subscriptions are **scoped**. `chat.text_delta/<sessionId>` only delivers
text deltas for that session. The gateway only sends what the connection's
auth grant authorises (see `packages/gateway/src/auth.ts`).

## Adding a method or event

1. Edit (or create) the namespace file in `packages/protocol/src/namespaces/`.
   Add the schema to its `*Methods` (or `*Events`) export. Add a TS type via
   `z.infer`.
2. Add the handler in `packages/gateway/src/dispatch/<namespace>.ts`. The
   `Dispatcher.register(method, handler)` call at gateway boot wires it up.
3. Implement on the consumer side (CLI, dashboard, channel — whichever needs
   it). They depend on `@squad/protocol` for the types.
4. Integration test under `packages/gateway/test/integration/` exercising the
   real WebSocket loop. Don't mock the protocol layer.

## Error envelope

`packages/protocol/src/errors.ts` — typed `ErrorCode` enum. Errors crossing
the wire use this envelope, not raw stack traces.

## Source map

- Frame parsing: `packages/protocol/src/frames.ts`
- Method registry: `packages/protocol/src/namespaces/index.ts`
- Per-namespace shapes: `packages/protocol/src/namespaces/<name>.ts`
- Dispatcher: `packages/gateway/src/dispatch/index.ts`
- Per-namespace handlers: `packages/gateway/src/dispatch/<name>.ts`
- Broadcast bus: `packages/gateway/src/broadcast.ts`
