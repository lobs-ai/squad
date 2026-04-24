import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
  type MessageCreateOptions,
  type ChatInputCommandInteraction,
} from "discord.js";
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
  send(text: string, options?: MessageCreateOptions): Promise<void>;
  /** Start a typing indicator until the first stream chunk / final send. */
  startTyping(): void;
}

export interface OutboundHandle {
  edit(text: string): Promise<void>;
  finish(text: string): Promise<void>;
}

export interface BotOptions {
  token: string;
  config: DiscordConfig;
  onInbound: InboundHandler;
}

export async function startBot(options: BotOptions): Promise<Client> {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
  });

  client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!shouldRespond(message, options.config, client.user?.id)) return;

    const content = stripMention(message.content, client.user?.id);
    if (!content.trim()) return;

    const sink = makeOutboundSink(message.channel, options.config.max_message_length);

    try {
      await options.onInbound({
        userId: message.author.id,
        userName: message.author.username,
        guildId: message.guildId ?? null,
        channelId: message.channelId,
        content,
        reply: sink,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await sink.send(`⚠️ ${msg}`);
    }
  });

  await client.login(options.token);
  return client;
}

/**
 * The structural subset of discord.js's `Message` that `shouldRespond`
 * actually reads. Kept narrow so unit tests can hand over plain objects
 * without pulling in the full discord.js client surface.
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

function stripMention(content: string, botUserId: string | undefined): string {
  if (!botUserId) return content;
  return content
    .replace(new RegExp(`<@!?${botUserId}>`, "g"), "")
    .trim();
}

function makeOutboundSink(channel: TextBasedChannel, limit: number): OutboundSink {
  return {
    async stream(text: string): Promise<OutboundHandle> {
      const [first, ...rest] = chunkMessage(text, limit);
      if (!("send" in channel)) {
        throw new Error("channel does not support sending messages");
      }
      let head = await channel.send(first ?? "...");
      for (const more of rest) {
        head = await channel.send(more);
      }
      return {
        async edit(newText: string): Promise<void> {
          const chunks = chunkMessage(newText, limit);
          // Edit the head to the first chunk; append the rest as new messages.
          await head.edit(chunks[0] ?? "...");
          for (const extra of chunks.slice(1)) {
            if (!("send" in channel)) continue;
            head = await channel.send(extra);
          }
        },
        async finish(finalText: string): Promise<void> {
          await head.edit(chunkMessage(finalText, limit)[0] ?? "...");
        },
      };
    },
    async send(text: string, opts?: MessageCreateOptions): Promise<void> {
      if (!("send" in channel)) return;
      const chunks = chunkMessage(text, limit);
      for (const c of chunks) await channel.send({ content: c, ...opts });
    },
    startTyping(): void {
      if ("sendTyping" in channel) void channel.sendTyping().catch(() => undefined);
    },
  };
}

export type { ChatInputCommandInteraction };
