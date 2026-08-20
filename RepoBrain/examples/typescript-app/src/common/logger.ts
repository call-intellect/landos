/**
 * Minimal structured logger. Keeps a stable interface so other modules can
 * depend on it without pulling in a logging framework.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  [key: string]: unknown;
}

function emit(level: LogLevel, message: string, fields?: LogFields): void {
  const record = {
    level,
    message,
    timestamp: new Date().toISOString(),
    ...fields,
  };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(record));
}

export const logger = {
  debug(message: string, fields?: LogFields): void {
    emit("debug", message, fields);
  },
  info(message: string, fields?: LogFields): void {
    emit("info", message, fields);
  },
  warn(message: string, fields?: LogFields): void {
    emit("warn", message, fields);
  },
  error(message: string, fields?: LogFields): void {
    emit("error", message, fields);
  },
};

export type Logger = typeof logger;
