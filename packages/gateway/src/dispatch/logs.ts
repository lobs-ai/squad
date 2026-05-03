import type { Dispatcher } from "./index.js";
import type { LogBuffer } from "../logs/buffer.js";

export function registerLogMethods(dispatcher: Dispatcher, buffer: LogBuffer): void {
  dispatcher.register("logs.tail", async (params) => {
    const entries = buffer.tail({
      ...(params.level !== undefined ? { level: params.level } : {}),
      ...(params.source !== undefined ? { source: params.source } : {}),
      ...(params.sinceId !== undefined ? { sinceId: params.sinceId } : {}),
      ...(params.q !== undefined ? { q: params.q } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : { limit: 200 }),
    });
    return { entries, sources: buffer.sources() };
  });
}
