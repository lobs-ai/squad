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
      if (topic.startsWith("chat.text_delta/")) {
        const d = data as { sessionId: string; delta: string };
        this.onTextDelta(d.sessionId, d.delta);
      } else if (topic.startsWith("chat.assistant_message/")) {
        const d = data as { sessionId: string; message: { content: Array<{ type: string; text?: string }> } };
        this.onAssistantFinal(d.sessionId, d.message.content);
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

        await this.gateway.request("chat.send", {
          sessionId,
          content: payload.content,
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

  private accumulators: Map<string, string> = new Map();

  private onTextDelta(sessionId: string, delta: string): void {
    if (!this.activeSessions.has(sessionId)) return;
    // Accumulate so an error after partial generation can still surface
    // whatever the model produced. Deltas don't drive any UI — typing
    // indicator stays on until the final message lands.
    const acc = (this.accumulators.get(sessionId) ?? "") + delta;
    this.accumulators.set(sessionId, acc);
  }

  private onAssistantFinal(sessionId: string, content: Array<{ type: string; text?: string }>): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const text = content
      .map((b) => (b.type === "text" && b.text ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    session.stopTyping();
    if (text) void session.sink.send(text);
    this.activeSessions.delete(sessionId);
    this.accumulators.delete(sessionId);
  }

  private onChatError(sessionId: string, message: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const acc = this.accumulators.get(sessionId);
    const errLine = `⚠️ ${message}`;
    const final = acc ? `${acc}\n\n${errLine}` : errLine;
    session.stopTyping();
    void session.sink.send(final);
    this.activeSessions.delete(sessionId);
    this.accumulators.delete(sessionId);
  }
}
