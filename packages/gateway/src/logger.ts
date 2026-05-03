import pino from "pino";
import { LogBuffer } from "./logs/buffer.js";

/**
 * Shared in-memory ring buffer of every log line the gateway emits. Boot
 * attaches a Broadcast to it once one exists, and the dispatch layer reads
 * from it for `logs.tail`.
 */
export const logBuffer = new LogBuffer();

export const logger = pino(
  {
    level: process.env.SQUAD_LOG_LEVEL ?? "info",
    base: { service: "squad-gateway" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  pino.multistream([
    { stream: process.stdout },
    { stream: logBuffer.stream() },
  ]),
);

export type Logger = typeof logger;
