import {
  Client,
  MessageCreateListener,
  ReadyListener,
} from "@buape/carbon";
import { GatewayPlugin, GatewayIntents } from "@buape/carbon/gateway";
import type { DiscordConfig } from "./config.js";
import { chunkMessage } from "./formatting.js";

export type InboundHandler = (payload: {
  userId: string;
  userName: string;
  guildId: string | null;
  channelId: string;
  content: string;
  reply: OutboundSink;
}) => Promise<void>;

export interface OutboundSink {
  /** Start (or continue) a streamed message. Returns a handle that can be edited. */
  stream(text: string): Promise<OutboundHandle>;
  /** Send a final one-shot message. */
  send(text: string): Promise<void>;
  /** Fire-and-forget typing indicator for ~10s. */
  startTyping(): void;
}

export interface OutboundHandle {
  edit(text: string): Promise<void>;
  finish(text: string): Promise<void>;
}

/** Minimal pino-shaped logger; optional — falls back to no-op. */
export interface BotLogger {
  info(meta: Record<string, unknown>, msg: string): void;
  warn(meta: Record<string, unknown>, msg: string): void;
  error(meta: Record<string, unknown>, msg: string): void;
}

const NOOP_LOGGER: BotLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

export interface BotOptions {
  token: string;
  config: DiscordConfig;
  onInbound: InboundHandler;
  logger?: BotLogger;
}

/**
 * Handle returned by `startBot`. Calling `disconnect()` closes the gateway
 * socket; the `applicationId` is the derived Discord app/bot user id, useful
 * for mention stripping.
 */
export interface BotHandle {
  client: Client;
  gateway: GatewayPlugin;
  applicationId: string;
  disconnect(): void;
}

/**
 * Bot accounts have `applicationId === botUserId`. The first segment of a bot
 * token is the bot's user id, base64-encoded. Decoding it saves us a REST
 * call just to populate Carbon's `clientId` requirement.
 */
function applicationIdFromToken(token: string): string {
  const first = token.split(".")[0];
  if (!first) throw new Error("invalid bot token");
  try {
    return Buffer.from(first, "base64").toString("utf-8");
  } catch {
    throw new Error("invalid bot token — first segment is not base64");
  }
}

export async function startBot(options: BotOptions): Promise<BotHandle> {
  const log = options.logger ?? NOOP_LOGGER;
  const applicationId = applicationIdFromToken(options.token);

  // Carbon listeners receive richly parsed data — `data.message` is a Carbon
  // Message (with .reply/.edit) and `data.author` is a User. We still build a
  // narrow ShouldRespondMessage so existing unit tests continue to work.
  class InboundMessageListener extends MessageCreateListener {
    async handle(
      data: {
        message: { content?: string; guildId?: string | null; channelId: string };
        author: { id: string; username?: string; bot?: boolean };
        rawMessage: { mentions?: Array<{ id: string }> };
      },
      client: Client,
    ): Promise<void> {
      const msg = data.message;
      const authorId = data.author.id;
      const guildId = msg.guildId ?? null;
      const channelId = msg.channelId;
      log.info(
        { authorId, authorBot: data.author.bot === true, guildId, channelId },
        "messageCreate handler invoked",
      );
      if (data.author.bot) return;

      const rsm: ShouldRespondMessage = {
        guildId,
        channelId,
        author: { id: authorId },
        mentions: {
          users: {
            has: (id: string) =>
              (data.rawMessage.mentions ?? []).some((u) => u.id === id),
          },
        },
      };
      const respond = shouldRespond(rsm, options.config, applicationId);
      log.info(
        { authorId, guildId, channelId, respond },
        "discord message received",
      );

      if (!respond) {
        const rejection = dmRejectionMessage(rsm, options.config);
        if (rejection) {
          await sendMessage(
            client,
            channelId,
            rejection,
            options.config.max_message_length,
          ).catch((err: unknown) => {
            log.warn({ err: String(err) }, "failed to send DM rejection");
          });
        }
        return;
      }

      const content = stripMention(msg.content ?? "", applicationId);
      if (!content.trim()) {
        log.info(
          { authorId, guildId, channelId },
          "discord message ignored: empty after strip",
        );
        return;
      }

      const sink = makeOutboundSink(
        client,
        channelId,
        options.config.max_message_length,
        log,
      );
      try {
        await options.onInbound({
          userId: authorId,
          userName: data.author.username ?? authorId,
          guildId,
          channelId,
          content,
          reply: sink,
        });
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log.error({ err: text, authorId, channelId }, "discord onInbound threw");
        await sink.send(`⚠️ ${text}`).catch(() => undefined);
      }
    }
  }

  class BotReadyListener extends ReadyListener {
    async handle(
      data: { user?: { id?: string; username?: string } },
    ): Promise<void> {
      log.info(
        { botId: data.user?.id, botTag: data.user?.username ?? "unknown" },
        "discord bot ready",
      );
    }
  }

  const intents =
    GatewayIntents.Guilds |
    GatewayIntents.GuildMessages |
    GatewayIntents.MessageContent |
    GatewayIntents.DirectMessages;

  const gateway = new GatewayPlugin({
    intents,
    reconnect: { maxAttempts: 50 },
  });

  const client = new Client(
    {
      // These four are required by Carbon's Client but only matter when the
      // interactions HTTP route is exposed, which we don't do here. Dummy
      // values keep the constructor happy.
      baseUrl: "http://localhost",
      clientId: applicationId,
      publicKey: "a",
      deploySecret: "a",
      token: options.token,
      autoDeploy: false,
    },
    {
      listeners: [new InboundMessageListener(), new BotReadyListener()],
    },
    [gateway],
  );

  // Kick off the websocket. `connect()` is sync — it schedules async work
  // internally (gateway info fetch, then identify / resume). The Ready
  // listener fires once we're authenticated.
  gateway.connect();

  return {
    client,
    gateway,
    applicationId,
    disconnect: () => gateway.disconnect(),
  };
}

/**
 * The structural subset of Carbon's `Message` (and discord.js's) that
 * `shouldRespond` reads. Kept narrow so unit tests can hand over plain
 * objects without pulling in a full client surface.
 */
export interface ShouldRespondMessage {
  guildId: string | null;
  channelId: string;
  author: { id: string };
  mentions: { users: { has: (id: string) => boolean } };
}

export function shouldRespond(
  message: ShouldRespondMessage,
  config: Pick<DiscordConfig, "bindings" | "dm_policy" | "dm_allow_list">,
  botUserId: string | undefined,
): boolean {
  // DM path: pure policy decision, independent of guild bindings.
  if (!message.guildId) {
    switch (config.dm_policy) {
      case "blocked":
        return false;
      case "open":
        return true;
      case "allow_list":
        return config.dm_allow_list.includes(message.author.id);
    }
  }
  // Guild channels: a configured binding pins the bot to a channel, while
  // an @mention lets it respond from anywhere in the server it's a member of.
  const bound = config.bindings.some(
    (b) => b.guild_id === message.guildId && b.channel_id === message.channelId,
  );
  if (bound) return true;
  if (botUserId && message.mentions.users.has(botUserId)) return true;
  return false;
}

/**
 * Courtesy message for an unpaired DM'er under "allow_list". Other policies
 * return null (silent for "blocked"; "open" never rejects).
 */
export function dmRejectionMessage(
  message: ShouldRespondMessage,
  config: Pick<DiscordConfig, "dm_policy" | "dm_allow_list">,
): string | null {
  if (message.guildId) return null;
  if (config.dm_policy !== "allow_list") return null;
  if (config.dm_allow_list.includes(message.author.id)) return null;
  const id = message.author.id;
  return [
    "You're not paired with this bot.",
    "Ask an admin to run this on the host:",
    "```",
    `squad pair discord ${id}`,
    "```",
    `Your Discord ID: ${id}`,
  ].join("\n");
}

function stripMention(content: string, botUserId: string | undefined): string {
  if (!botUserId) return content;
  return content.replace(new RegExp(`<@!?${botUserId}>`, "g"), "").trim();
}

type MessagePostResponse = { id: string };

async function sendMessage(
  client: Client,
  channelId: string,
  content: string,
  limit: number,
): Promise<{ id: string }> {
  const chunks = chunkMessage(content, limit);
  let head: MessagePostResponse | null = null;
  for (const chunk of chunks) {
    const response = (await client.rest.post(`/channels/${channelId}/messages`, {
      body: { content: chunk },
    })) as MessagePostResponse;
    if (!head) head = response;
  }
  return head ?? { id: "" };
}

/**
 * Outbound sink that uses Carbon's REST client directly. We post the first
 * chunk eagerly to get a message id for later edits; subsequent chunks are
 * appended as new messages. The streaming pattern intentionally stays
 * identical to the discord.js implementation the CLI contract was built
 * around.
 */
function makeOutboundSink(
  client: Client,
  channelId: string,
  limit: number,
  log: BotLogger,
): OutboundSink {
  return {
    async stream(text: string): Promise<OutboundHandle> {
      const [first, ...rest] = chunkMessage(text || "...", limit);
      const firstResponse = (await client.rest.post(
        `/channels/${channelId}/messages`,
        { body: { content: first ?? "..." } },
      )) as MessagePostResponse;
      let headId = firstResponse.id;
      for (const extra of rest) {
        const response = (await client.rest.post(
          `/channels/${channelId}/messages`,
          { body: { content: extra } },
        )) as MessagePostResponse;
        headId = response.id;
      }
      return {
        async edit(newText: string): Promise<void> {
          const chunks = chunkMessage(newText || "...", limit);
          await client.rest.patch(
            `/channels/${channelId}/messages/${headId}`,
            { body: { content: chunks[0] ?? "..." } },
          );
          for (const extra of chunks.slice(1)) {
            const response = (await client.rest.post(
              `/channels/${channelId}/messages`,
              { body: { content: extra } },
            )) as MessagePostResponse;
            headId = response.id;
          }
        },
        async finish(finalText: string): Promise<void> {
          const chunks = chunkMessage(finalText || "...", limit);
          await client.rest.patch(
            `/channels/${channelId}/messages/${headId}`,
            { body: { content: chunks[0] ?? "..." } },
          );
        },
      };
    },
    async send(text: string): Promise<void> {
      await sendMessage(client, channelId, text, limit);
    },
    startTyping(): void {
      // Discord auto-clears typing after 10s or on the next message send —
      // fire and forget; errors don't matter.
      void client.rest
        .post(`/channels/${channelId}/typing`, { body: {} })
        .catch((err: unknown) => {
          log.warn({ err: String(err) }, "startTyping failed");
        });
    },
  };
}
