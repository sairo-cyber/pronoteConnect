const sensitiveKey = /(?:token|password|passwd|mdp|cookie|authorization|loginstate|secret|jeton)/iu;
const bearer = /Bearer\s+[A-Za-z0-9._~+/=-]+/giu;
const tokenLike = /\b(?:sk|token|jeton)[-_][A-Za-z0-9_-]{8,}\b/giu;

export function redactText(value: string, knownSecrets: readonly string[] = []): string {
  let redacted = value.replace(bearer, "Bearer [REDACTED]").replace(tokenLike, "[REDACTED]");
  for (const secret of knownSecrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

export function redact(value: unknown, knownSecrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, knownSecrets);
  if (Array.isArray(value)) return value.map((item) => redact(item, knownSecrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : redact(item, knownSecrets),
      ]),
    );
  }
  return value;
}

export interface SafeLogger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export function createSafeLogger(knownSecrets: () => readonly string[] = () => []): SafeLogger {
  const write = (level: "info" | "warn" | "error", message: string, details?: unknown): void => {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message: redactText(message, knownSecrets()),
      ...(details === undefined ? {} : { details: redact(details, knownSecrets()) }),
    };
    process.stderr.write(`${JSON.stringify(entry)}\n`);
  };
  return {
    info: (message, details) => write("info", message, details),
    warn: (message, details) => write("warn", message, details),
    error: (message, details) => write("error", message, details),
  };
}
