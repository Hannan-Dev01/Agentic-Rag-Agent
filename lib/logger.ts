/**
 * PHASE 13 — STRUCTURED LOGGING
 *
 * A tiny structured logger. Emitting JSON (not string concatenation) means logs
 * are queryable in production (Datadog, CloudWatch, Vercel logs). We never log
 * secrets or full document text — only sizes/ids/durations.
 */
type Level = "info" | "warn" | "error";

function log(level: Level, event: string, data?: Record<string, unknown>) {
  const line = JSON.stringify({
    level,
    event,
    ts: new Date().toISOString(),
    ...data,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  info: (event: string, data?: Record<string, unknown>) => log("info", event, data),
  warn: (event: string, data?: Record<string, unknown>) => log("warn", event, data),
  error: (event: string, data?: Record<string, unknown>) => log("error", event, data),
};
