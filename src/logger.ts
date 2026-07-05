import pino from "pino";

/**
 * Structured JSON logs on stdout — one event per line, cron/log-collector friendly.
 * Set LOG_LEVEL=debug for per-page fetch detail.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
