/**
 * ReplyBackend — minimal interface the `reply` tool talks to.
 *
 * The gateway implements this in terms of its SessionStore + ChannelRegistry:
 * it resolves the session's platform + remote target and dispatches the
 * message to the matching channel's outbound sender. The tools package stays
 * ignorant of sessions, channels, and platform specifics.
 */

export interface ReplyArgs {
  /** Session the turn is running for. Identifies the originating channel. */
  sessionId: string;
  /** Message text to deliver to the channel. */
  content: string;
  /**
   * Optional channel/thread id to post to instead of the session's default
   * channel. Must be on the same platform as the session.
   */
  channelId?: string;
}

export interface ReplyResult {
  /** Platform-assigned id of the sent message, when the channel returns one. */
  messageId?: string;
}

export interface ReplyBackend {
  reply(args: ReplyArgs): Promise<ReplyResult>;
}
