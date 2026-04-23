import type { ChannelCapabilities } from "@squad/protocol";

/**
 * Lifecycle contract every channel implements. In-process channels implement
 * this directly against the gateway's stores; out-of-process channels use
 * `SquadGatewayClient` under the hood.
 */
export abstract class Channel {
  /** Unique channel id (e.g. "discord"). */
  abstract readonly id: string;

  /** Declared capabilities. The gateway degrades gracefully based on these. */
  abstract readonly capabilities: ChannelCapabilities;

  /** Connect to the underlying platform (Discord gateway, etc.). */
  abstract connect(): Promise<void>;

  /** Disconnect cleanly. */
  abstract disconnect(): Promise<void>;
}
