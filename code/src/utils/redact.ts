const sensitiveKey = /authorization|api[-_]?key|(?:^|[-_])(?:access[-_]?token|refresh[-_]?token|token)(?:$|[-_])|password|secret|credential|cookie/i;

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, sensitiveKey.test(key) ? "[REDACTED]" : redactSensitive(entry)
    ]));
  }
  if (typeof value === "string") {
    return value.replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
      .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  }
  return value;
}
