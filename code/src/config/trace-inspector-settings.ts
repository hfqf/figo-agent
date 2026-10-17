export interface TraceInspectorSettings {
  detailCollectionLimit: number;
  fieldPreviewChars: number;
  responseBudgetChars: number;
  maxFieldChars: number;
  fieldPageChars: number;
  fieldMaxPageChars: number;
  maxPreviewNodes: number;
}

export const defaultTraceInspectorSettings: TraceInspectorSettings = {
  detailCollectionLimit: 200,
  fieldPreviewChars: 16384,
  responseBudgetChars: 900000,
  maxFieldChars: 8388608,
  fieldPageChars: 32768,
  fieldMaxPageChars: 131072,
  maxPreviewNodes: 20000
};

export function readTraceInspectorSettings(value: unknown): TraceInspectorSettings {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("web.traceInspector 必须是对象。");
  const input = (value ?? {}) as Record<string, unknown>;
  const result = { ...defaultTraceInspectorSettings };
  for (const key of Object.keys(result) as Array<keyof TraceInspectorSettings>) {
    if (input[key] === undefined) continue;
    const n = input[key];
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 1 || n > 67108864) throw new Error(`web.traceInspector.${key} 必须是有效正整数。`);
    result[key] = n;
  }
  if (result.fieldPreviewChars > result.maxFieldChars || result.fieldPageChars > result.fieldMaxPageChars
    || result.fieldMaxPageChars > result.maxFieldChars || result.detailCollectionLimit > 1000) throw new Error("web.traceInspector 配置范围无效。");
  return result;
}
