import type { Dispatcher } from "./index.js";
import type { AppRegistry } from "../apps/registry.js";
import { ProtocolError, ErrorCode } from "@squad/protocol";

export function registerAppMethods(dispatcher: Dispatcher, registry: AppRegistry): void {
  dispatcher.register("apps.list", async () => ({ apps: registry.list() }));

  dispatcher.register("apps.get", async (params) => {
    const app = registry.get(params.name);
    if (!app) {
      throw new ProtocolError(ErrorCode.not_found, `unknown app: ${params.name}`);
    }
    return { app };
  });

  dispatcher.register("apps.unregister", async (params) => {
    const ok = registry.unregister(params.name);
    if (!ok) {
      throw new ProtocolError(ErrorCode.not_found, `unknown app: ${params.name}`);
    }
    return { name: params.name };
  });
}
