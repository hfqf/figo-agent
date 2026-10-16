const sensitiveKey = /authorization|api[-_]?key|(?:^|[-_])(?:access[-_]?token|refresh[-_]?token|token)(?:$|[-_])|password|secret|credential|cookie/i;
const tokenPattern = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const credentialAssignment = /\b(authorization|proxy-authorization|api[-_ ]?key|access[-_]?token|refresh[-_]?token|token|password|secret|credential|cookie|set-cookie)(["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*(?:"|(?:\\)?$)|'(?:\\.|[^'\\])*(?:'|(?:\\)?$)|(?:Bearer|Basic)\s+[^\s,"'<>}&;]+|[^\s,"'<>}&;]+)/gi;

export function redactForUi(value: unknown, secrets: string[] = []): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactForUi(entry, secrets));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key, sensitiveKey.test(key) ? "[REDACTED]" : redactForUi(entry, secrets)
    ]));
  }
  if (typeof value !== "string") return value;
  let result = value;
  for (const secret of secrets.filter(Boolean).sort((left, right) => right.length - left.length)) {
    result = result.replaceAll(secret, "[REDACTED]");
  }
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
  // 原文也可能包含配置片段；只识别凭据赋值，不匹配 prompt_tokens 等用量字段。
  return result.replace(credentialAssignment, "$1$2[REDACTED]");
}
