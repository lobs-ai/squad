import pino from "pino";

export const logger = pino({
  level: process.env.SQUAD_LOG_LEVEL ?? "info",
  base: { service: "squad-gateway" },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export type Logger = typeof logger;
