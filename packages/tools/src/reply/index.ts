// The `reply` tool lets the agent send messages to the channel a conversation
// is on. It is NOT a lazy tool group: the gateway registers it into the
// ToolRegistry at boot and exposes it per-turn only for channel sessions (see
// runs.ts). The tools package only owns the tool + the backend contract; the
// gateway implements ReplyBackend against its sessions + channel registry.
export type { ReplyArgs, ReplyResult, ReplyBackend } from "./backend.js";
export { ReplyTool, registerReplyTool } from "./tools.js";
