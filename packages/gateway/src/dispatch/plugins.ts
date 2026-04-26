import type { Dispatcher } from "./index.js";
import type { PluginHost } from "../plugins/host.js";

export function registerPluginMethods(dispatcher: Dispatcher, host: PluginHost): void {
  dispatcher.register("plugins.list", async () => ({ plugins: host.records() }));

  dispatcher.register("plugins.enable", async (params) => {
    const r = host.setEnabled(params.id, true);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.disable", async (params) => {
    const r = host.setEnabled(params.id, false);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.reload", async (params) => {
    const r = await host.reload(params.id);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });

  dispatcher.register("plugins.configure", async (params) => {
    const r = host.setConfig(params.id, params.config);
    if (!r) throw new Error(`unknown plugin: ${params.id}`);
    return { plugin: r };
  });
}
