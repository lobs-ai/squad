import type { Dispatcher } from "./index.js";
import type { RoutineRunner, RoutineStore, CreateInput } from "../routines/store.js";
import { readRunLog } from "../routines/persistence.js";
import type { CronPaths } from "../routines/persistence.js";

export interface RoutineDispatchDeps {
  store: RoutineStore;
  runner: RoutineRunner;
  /** Optional — when omitted, `routines.runs` and `routines.tail` return []. */
  paths?: CronPaths;
}

export function registerRoutineMethods(
  dispatcher: Dispatcher,
  deps: RoutineDispatchDeps,
): void {
  const { store, runner, paths } = deps;

  dispatcher.register("routines.list", async () => ({ routines: store.list() }));

  dispatcher.register("routines.create", async (params) => {
    const record = store.create(params as CreateInput);
    return { routine: record };
  });

  dispatcher.register("routines.update", async (params) => {
    const record = store.update(params);
    if (!record) throw new Error(`unknown routine: ${params.id}`);
    return { routine: record };
  });

  dispatcher.register("routines.delete", async (params) => {
    const ok = store.delete(params.id);
    if (!ok) throw new Error(`unknown routine: ${params.id}`);
    return { id: params.id };
  });

  dispatcher.register("routines.run_now", async (params) => {
    const result = await store.runNow(params.id, runner);
    return { sessionId: result.sessionId };
  });

  dispatcher.register("routines.runs", async (params) => {
    if (!paths) return { runs: [] };
    const runs = readRunLog(paths.runs, params.jobId, {
      limit: params.limit,
      ...(params.status ? { status: params.status } : {}),
    });
    return { runs };
  });

  dispatcher.register("routines.tail", async (params) => {
    if (!paths) return { runs: [] };
    const runs = readRunLog(paths.runs, params.jobId, { limit: params.limit });
    return { runs };
  });
}
