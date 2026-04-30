import type { ToolGroup } from "../groups.js";
import { CRON_GUIDANCE } from "./prompt.js";

export type {
  CronBackend,
  CronJobSummary,
  CronRunSummary,
  ScheduleInput as CronScheduleInput,
  PayloadInput as CronPayloadInput,
  SessionTargetInput as CronSessionTargetInput,
  ExecutionInput as CronExecutionInput,
  DeliveryInput as CronDeliveryInput,
} from "./backend.js";
export {
  CreateCronJobTool,
  UpdateCronJobTool,
  DeleteCronJobTool,
  ListCronJobsTool,
  GetCronJobTool,
  RunCronJobTool,
  GetCronRunsTool,
  registerCronTools,
} from "./tools.js";
export { CRON_GUIDANCE } from "./prompt.js";

/** Lazy-loadable tool group for cron scheduling. */
export const cronGroup: ToolGroup = {
  name: "cron",
  description:
    "Schedule recurring or one-off work (cron / interval / once) — prompts, scripts, or full agent turns",
  toolNames: [
    "create_cron_job",
    "update_cron_job",
    "delete_cron_job",
    "list_cron_jobs",
    "get_cron_job",
    "run_cron_job",
    "get_cron_runs",
  ],
  guidance: CRON_GUIDANCE,
};
