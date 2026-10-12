const sensitiveKey = /authorization|api[-_]?key|(?:^|[-_])(?:access[-_]?token|refresh[-_]?token|token)(?:$|[-_])|password|secret|credential|cookie/i;
const tokenPattern = /\bsk-[A-Za-z0-9_-]{12,}\b/g;

export function redactForUi(value: unknown, secrets: string[] = [], workspaceRoot?: string): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactForUi(entry, secrets, workspaceRoot));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, sensitiveKey.test(key) ? "[REDACTED]" : redactForUi(entry, secrets, workspaceRoot)
    ]));
  }
  if (typeof value !== "string") return value;
  let result = value;
  for (const secret of secrets) {
    if (secret) result = result.replaceAll(secret, "[REDACTED]");
  }
  if (workspaceRoot) result = result.replaceAll(workspaceRoot, ".");
  result = result.replace(tokenPattern, "[REDACTED]").replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]");
  if (/^https?:\/\//i.test(result)) {
    try {
      const url = new URL(result);
      if (url.username) url.username = "[REDACTED]";
      if (url.password) url.password = "[REDACTED]";
      for (const key of url.searchParams.keys()) {
        if (sensitiveKey.test(key) || /(?:^|[-_])(?:token|key|code)(?:$|[-_])/i.test(key)) {
          url.searchParams.set(key, "[REDACTED]");
        }
      }
      return url.toString();
    } catch { /* Non-URL text keeps the string-level redaction. */ }
  }
  return result;
}
