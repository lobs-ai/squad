import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
  type TextBasedChannel,
  type MessageCreateOptions,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { DiscordConfig, DiscordBinding } from "./config.js";
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
    if (!shouldRespond(message, options.config.bindings, client.user?.id)) return;

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

function shouldRespond(
  message: Message,
  bindings: DiscordBinding[],
  botUserId: string | undefined,
): boolean {
  // DMs always respond if a DM binding exists.
  if (!message.guildId) {
    return bindings.some((b) => "dm" in b && b.dm);
  }
  // Otherwise require a configured guild+channel binding or an @mention.
  const bound = bindings.some(
    (b) =>
      "guild_id" in b &&
      b.guild_id === message.guildId &&
      b.channel_id === message.channelId,
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
