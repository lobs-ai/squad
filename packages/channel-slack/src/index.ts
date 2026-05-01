import { definePlugin, type ChannelHandle } from "@squad/plugin-sdk";
import { SlackRenderer, type SlackTransport } from "./renderer.js";

/**
 * Slack channel plugin. The actual transport (Bolt's `app.client` or the
 * Web API client) is injected via plugin config so this package stays
 * dependency-light. Real installs ship a `bolt.ts` that wires Bolt + the
 * gateway WS client; the renderer + capabilities are reusable as-is.
 */
export interface SlackPluginConfig {
  channelId: string;
  threadTs?: string;
  /**
   * Transport supplier. Tests pass a mock; real installs pass a Bolt-backed
   * implementation. Bolt itself isn't a runtime dep of this package — keep
   * the surface small and let consumers pick their own Slack SDK.
   */
  transport: SlackTransport;
  /** Channel id used in the gateway's channel registry. Defaults to "slack". */
  id?: string;
  label?: string;
}

export { SlackRenderer } from "./renderer.js";
export type { SlackTransport } from "./renderer.js";

/**
 * Build a `ChannelHandle` directly — useful when wiring channels manually
 * (tests, custom hosts) rather than via plugin config.
 */
export function createSlackChannel(config: SlackPluginConfig): ChannelHandle {
  const renderer = new SlackRenderer({
    channelId: config.channelId,
    transport: config.transport,
    ...(config.threadTs ? { threadTs: config.threadTs } : {}),
  });
  // Attach the renderer to the handle for inspection. Channel hosts that
  // honor the renderer contract do so via this property.
  const handle: ChannelHandle & { renderer: SlackRenderer } = {
    id: config.id ?? "slack",
    kind: "slack",
    label: config.label ?? "Slack",
    capabilities: {
      supportsPreview: true,
      supportsMultiSelect: false,
      supportsFreeText: true,
      maxOptions: 5,
      supportsImages: true,
      supportsFileUploads: true,
      supportsTaskList: true,
      supportsApprovals: true,
    },
    async start() {
      // Real installs would start Bolt's socket-mode listener here.
      // The skeleton's transport is already pre-wired by config.
    },
    async stop() {
      // Real installs would stop Bolt here.
    },
    renderer,
  };
  return handle;
}

export default definePlugin({
  id: "@squad/channel-slack",
  name: "Slack",
  version: "0.0.0",
  kinds: ["channel"],
  register(api) {
    const config = (api.config ?? {}) as Partial<SlackPluginConfig>;
    if (!config.channelId || !config.transport) {
      api.logger.error("@squad/channel-slack requires channelId + transport in config");
      return;
    }
    const handle = createSlackChannel({
      channelId: config.channelId,
      transport: config.transport,
      ...(config.threadTs !== undefined ? { threadTs: config.threadTs } : {}),
      ...(config.id !== undefined ? { id: config.id } : {}),
      ...(config.label !== undefined ? { label: config.label } : {}),
    });
    api.channels.register(handle);
    return () => {
      void handle.stop();
    };
  },
});
