import type { Dispatcher } from "./index.js";
import type { RoutineRunner, RoutineStore } from "../routines/store.js";

export function registerRoutineMethods(
  dispatcher: Dispatcher,
  store: RoutineStore,
  runner: RoutineRunner,
): void {
  dispatcher.register("routines.list", async () => ({ routines: store.list() }));

  dispatcher.register("routines.create", async (params) => {
    const record = store.create({
      name: params.name,
      cron: params.cron,
      prompt: params.prompt,
      ...(params.model !== undefined ? { model: params.model } : {}),
      delivery: params.delivery,
      enabled: params.enabled,
    });
    return { routine: record };
  });

  dispatcher.register("routines.update", async (params) => {
    const record = store.update({
      id: params.id,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.cron !== undefined ? { cron: params.cron } : {}),
      ...(params.prompt !== undefined ? { prompt: params.prompt } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.delivery !== undefined ? { delivery: params.delivery } : {}),
      ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
    });
    if (!record) throw new Error(`unknown routine: ${params.id}`);
    return { routine: record };
  });

  dispatcher.register("routines.delete", async (params) => {
    const ok = store.delete(params.id);
    if (!ok) throw new Error(`unknown routine: ${params.id}`);
    return { id: params.id };
  });

  dispatcher.register("routines.run_now", async (params) => {
    return store.runNow(params.id, runner);
  });
}
