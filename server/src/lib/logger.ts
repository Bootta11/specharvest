type Level = "debug" | "info" | "warn" | "error";

const debugEnabled = /^(1|true|yes)$/i.test(process.env.DEBUG ?? "");

export function createLogger(scope: string) {
  const write = (level: Level, message: string, data?: unknown) => {
    if (level === "debug" && !debugEnabled) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    if (data === undefined) fn(line);
    else fn(line, typeof data === "string" ? data : JSON.stringify(data));
  };
  return {
    debug: (m: string, d?: unknown) => write("debug", m, d),
    info: (m: string, d?: unknown) => write("info", m, d),
    warn: (m: string, d?: unknown) => write("warn", m, d),
    error: (m: string, d?: unknown) => write("error", m, d),
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
