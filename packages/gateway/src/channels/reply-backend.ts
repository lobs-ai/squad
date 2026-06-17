import type { ReplyBackend } from "@squad/tools";
import type { SessionStore } from "../db/sessions.js";
import type { ChannelRegistry } from "./registry.js";

/**
 * Gateway implementation of the `reply` tool's backend. Resolves the session's
 * platform + remote target and dispatches the message to the matching
 * channel's outbound sender (registered by the channel plugin as
 * `ChannelHandle.send`).
 *
 * `session.platform` is the channel kind (e.g. "discord"); `session.remoteId`
 * is the channel's own route key. The channel decodes the route key itself, so
 * the gateway stays free of platform specifics.
 */
export function replyBackendFor(deps: {
  sessions: SessionStore;
  channels: ChannelRegistry;
}): ReplyBackend {
  return {
    async reply({ sessionId, content, channelId }) {
      const session = deps.sessions.tryGet(sessionId);
      if (!session) throw new Error(`reply: session ${sessionId} not found`);
      const platform = session.platform;
      if (!platform) {
        throw new Error(
          "reply: this session isn't attached to a channel, so there's nowhere to send. " +
            "On the dashboard/CLI your turn is delivered directly — just write your answer.",
        );
      }
      const sender = deps.channels.senderForKind(platform);
      if (!sender) {
        throw new Error(
          `reply: no connected "${platform}" channel is available to send through.`,
        );
      }
      const result = await sender(
        { remoteId: session.remoteId, ...(channelId ? { channelId } : {}) },
        content,
      );
      return result ?? {};
    },
  };
}
