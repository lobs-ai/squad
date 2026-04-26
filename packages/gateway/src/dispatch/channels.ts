import type { Dispatcher } from "./index.js";
import type { ChannelRegistry } from "../channels/registry.js";

export function registerChannelMethods(dispatcher: Dispatcher, channels: ChannelRegistry): void {
  dispatcher.register("channels.list", async () => ({ channels: channels.list() }));

  dispatcher.register("channels.bind", async (params) => ({
    binding: channels.bind({
      channelId: params.channelId,
      sessionId: params.sessionId,
      route: params.route as Record<string, unknown>,
    }),
  }));

  dispatcher.register("channels.unbind", async (params) => {
    const ok = channels.unbind(params.bindingId);
    if (!ok) throw new Error(`unknown binding: ${params.bindingId}`);
    return { bindingId: params.bindingId };
  });

  dispatcher.register("channels.capabilities", async (params) => {
    const caps = channels.capsFor(params.channelId);
    return { channelId: params.channelId, capabilities: caps };
  });
}
