import { Channel, SessionMap, SquadGatewayClient } from "@squad/channel-sdk";
import { startBot, type BotHandle, type BotLogger, type OutboundHandle } from "./bot.js";
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
  private readonly activeStreams: Map<string, OutboundHandle> = new Map();

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
    await this.gateway.connect();

    this.gateway.onEvent((topic, data) => {
      if (topic.startsWith("chat.text_delta/")) {
        const d = data as { sessionId: string; delta: string };
        this.onTextDelta(d.sessionId, d.delta);
      } else if (topic.startsWith("chat.assistant_message/")) {
        const d = data as { sessionId: string; message: { content: Array<{ type: string; text?: string }> } };
        this.onAssistantFinal(d.sessionId, d.message.content);
      }
    });

    this.bot = await startBot({
      token: resolveBotToken(this.options.config),
      config: this.options.config,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      onInbound: async (payload) => {
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
        }

        payload.reply.startTyping();
        const handle = await payload.reply.stream("…");
        this.activeStreams.set(sessionId, handle);

        await this.gateway.request("chat.send", {
          sessionId,
          content: payload.content,
        });
      },
    });
  }

  async disconnect(): Promise<void> {
    this.bot?.disconnect();
    this.bot = null;
    this.gateway.close();
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
    const handle = this.activeStreams.get(sessionId);
    if (!handle) return;
    const acc = (this.accumulators.get(sessionId) ?? "") + delta;
    this.accumulators.set(sessionId, acc);
    // Debounce: every ~200ms of deltas. For simplicity here we just edit on
    // every delta; the full D1 implementation throttles to avoid rate limits.
    void handle.edit(acc);
  }

  private onAssistantFinal(sessionId: string, content: Array<{ type: string; text?: string }>): void {
    const handle = this.activeStreams.get(sessionId);
    if (!handle) return;
    const text = content
      .map((b) => (b.type === "text" && b.text ? b.text : ""))
      .filter(Boolean)
      .join("\n");
    void handle.finish(text);
    this.activeStreams.delete(sessionId);
    this.accumulators.delete(sessionId);
  }
}
