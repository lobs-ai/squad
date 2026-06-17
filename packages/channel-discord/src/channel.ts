import { Channel, SessionMap, SquadGatewayClient } from "@squad/channel-sdk";
import { startBot, type BotHandle, type BotLogger, type OutboundSink } from "./bot.js";
import { DISCORD_CAPABILITIES } from "./capabilities.js";
import { resolveBotToken, resolveGatewayToken, type DiscordConfig } from "./config.js";
import { chunkMessage } from "./formatting.js";
import { join } from "node:path";

export interface DiscordChannelOptions {
  config: DiscordConfig;
  /**
   * Storage directory for the session map (falls back to the current working
   * directory under `./data/discord-sessions.jsonl`).
   */
  dataDir?: string;
  /** Optional logger — plumbed through to bot.ts so messageCreate decisions
   * show up in the gateway's log stream. */
  logger?: BotLogger;
}

/**
 * Standalone Discord channel. Connects to the gateway via WebSocket and to
 * Discord via discord.js. For the in-gateway variant see `./plugin.ts` —
 * it implements the same contract against the gateway's stores directly.
 */
export class DiscordChannel extends Channel {
  readonly id = "discord";
  readonly capabilities = DISCORD_CAPABILITIES;

  private bot: BotHandle | null = null;
  private readonly gateway: SquadGatewayClient;
  private readonly sessionMap: SessionMap;
  private readonly activeSessions: Map<
    string,
    { sink: OutboundSink; stopTyping: () => void }
  > = new Map();

  constructor(private readonly options: DiscordChannelOptions) {
    super();
    const dataDir = options.dataDir ?? "./data";
    this.sessionMap = new SessionMap(join(dataDir, "discord-sessions.jsonl"));
    this.gateway = new SquadGatewayClient({
      url: options.config.gateway_url,
      token: resolveGatewayToken(options.config),
    });
  }

  async connect(): Promise<void> {
    this.options.logger?.info(
      { gatewayUrl: this.options.config.gateway_url },
      "discord channel: connecting to gateway",
    );
    await this.gateway.connect();
    this.options.logger?.info({}, "discord channel: gateway WS connected");

    this.gateway.onEvent((topic, data) => {
      // The agent delivers its own replies via the `reply` tool during the
      // run, so we don't auto-send anything on assistant_message — we only use
      // it as the run-complete signal to stop the typing indicator and clean
      // up. Errors still surface to the channel so failures aren't silent.
      if (topic.startsWith("chat.assistant_message/")) {
        const d = data as { sessionId: string };
        this.onRunComplete(d.sessionId);
      } else if (topic.startsWith("chat.error/")) {
        const d = data as { sessionId: string; message: string };
        this.onChatError(d.sessionId, d.message);
      }
    });

    this.bot = await startBot({
      token: resolveBotToken(this.options.config),
      config: this.options.config,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      onInbound: async (payload) => {
        this.options.logger?.info(
          {
            guildId: payload.guildId,
            channelId: payload.channelId,
            userId: payload.userId,
            chars: payload.content.length,
          },
          "discord channel: inbound message",
        );
        const key = `${payload.guildId ?? "dm"}:${payload.channelId}:${payload.userId}`;
        let sessionId = this.sessionMap.get(key);
        if (!sessionId) {
          const { session } = await this.gateway.request("session.start", {
            title: `Discord ${payload.userName}`,
            platform: "discord",
            remoteId: key,
          });
          sessionId = session.id;
          this.sessionMap.set(key, sessionId);
          await this.gateway.subscribe([
            `chat.*/${sessionId}`,
            `tasks.*/${sessionId}`,
            `questions.*/${sessionId}`,
          ]);
          this.options.logger?.info(
            { sessionId, key, userName: payload.userName },
            "discord channel: started new session",
          );
        }

        const stopTyping = payload.reply.startTyping();
        this.activeSessions.set(sessionId, { sink: payload.reply, stopTyping });

        // Frame the inbound message so the agent knows it arrived from a
        // Discord channel (and which one). How to respond — that nothing is
        // auto-sent and replies go through the `reply` tool — is covered by
        // the system prompt for channel turns.
        await this.gateway.request("chat.send", {
          sessionId,
          content: frameInbound(payload),
        });
      },
    });
  }

  async disconnect(): Promise<void> {
    this.options.logger?.info({}, "discord channel: disconnecting");
    this.bot?.disconnect();
    this.bot = null;
    this.gateway.close();
    this.options.logger?.info({}, "discord channel: disconnected");
  }

  /**
   * Live bot handle, or null when not connected. Exposed so the tools
   * backend can route REST calls through the same Carbon client the channel
   * uses for inbound/outbound traffic.
   */
  getBot(): BotHandle | null {
    return this.bot;
  }

  /**
   * Post a one-shot message to a specific Discord channel — used by the
   * routine delivery handler ("post the cron run output to #ops"). Errors
   * propagate so the delivery dispatch can record them in the run log.
   */
  async sendToChannel(channelId: string, content: string): Promise<void> {
    if (!this.bot) {
      throw new Error("discord channel is not connected");
    }
    const limit = this.options.config.max_message_length;
    const chunks = chunkMessage(content || "(no output)", limit);
    for (const chunk of chunks) {
      await this.bot.client.rest.post(`/channels/${channelId}/messages`, {
        body: { content: chunk },
      });
    }
  }

  /**
   * Run finished. The agent's replies (if any) already went out via the
   * `reply` tool, so there's nothing to send here — just stop the typing
   * indicator and release the per-message sink.
   */
  private onRunComplete(sessionId: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    session.stopTyping();
    this.activeSessions.delete(sessionId);
  }

  private onChatError(sessionId: string, message: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    session.stopTyping();
    void session.sink.send(`⚠️ ${message}`);
    this.activeSessions.delete(sessionId);
  }
}

/**
 * Wrap an inbound Discord message with a one-line source header so the agent
 * knows where it came from (and the channel id, in case it wants to target a
 * thread or use the richer `discord_message` tool). The reply mechanics live
 * in the system prompt, not here.
 */
function frameInbound(payload: {
  channelId: string;
  guildId: string | null;
  userName: string;
  content: string;
}): string {
  const where = payload.guildId
    ? `channel ${payload.channelId}, guild ${payload.guildId}`
    : `DM, channel ${payload.channelId}`;
  return `[New Discord message — ${where}, from ${payload.userName}]\n${payload.content}`;
}
