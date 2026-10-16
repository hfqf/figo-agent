export interface PiCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
  summaryToolResultMaxChars: number;
  modelOverrides: Record<string, { reserveTokens?: number; keepRecentTokens?: number }>;
}

export function readPiCompactionSettings(value: unknown): PiCompactionSettings {
  const source = value === undefined || value === null ? {} : readObject(value, "压缩配置");
  const enabledField = source.enabled === undefined ? "autoEnabled" : "enabled";
  const enabled = source[enabledField];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw new Error(`${enabledField} 必须是布尔值。`);
  }
  const reserveTokens = readInteger(source.reserveTokens, "reserveTokens") ?? 16384;
  const keepRecentTokens = readInteger(source.keepRecentTokens, "keepRecentTokens") ?? 20000;
  const summaryToolResultMaxChars = readInteger(source.summaryToolResultMaxChars, "summaryToolResultMaxChars", 1) ?? 2000;
  const overrides = source.modelOverrides === undefined ? {} : readObject(source.modelOverrides, "modelOverrides");
  const modelOverrides = Object.fromEntries(Object.entries(overrides).map(([key, value]) => {
    const path = `modelOverrides[${key}]`;
    const entry = readObject(value, path);
    const override: PiCompactionSettings["modelOverrides"][string] = {};
    const reserve = readInteger(entry.reserveTokens, `${path}.reserveTokens`);
    const recent = readInteger(entry.keepRecentTokens, `${path}.keepRecentTokens`);
    if (reserve !== undefined) override.reserveTokens = reserve;
    if (recent !== undefined) override.keepRecentTokens = recent;
    return [key, override];
  }));
  return { enabled: enabled ?? true, reserveTokens, keepRecentTokens, summaryToolResultMaxChars, modelOverrides };
}

export function resolvePiCompactionSettings(
  config: PiCompactionSettings, providerId: string, modelId: string
): { enabled: boolean; reserveTokens: number; keepRecentTokens: number; summaryToolResultMaxChars: number } {
  const settings = readPiCompactionSettings(config);
  const key = `${providerId}/${modelId}`;
  const override = Object.hasOwn(settings.modelOverrides, key) ? settings.modelOverrides[key] : undefined;
  return {
    enabled: settings.enabled,
    reserveTokens: override?.reserveTokens ?? settings.reserveTokens,
    keepRecentTokens: override?.keepRecentTokens ?? settings.keepRecentTokens,
    summaryToolResultMaxChars: settings.summaryToolResultMaxChars
  };
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function readInteger(value: unknown, path: string, minimum: 0 | 1 = 0): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${path} 必须是${minimum === 0 ? "非负" : "正"}安全整数。`);
  }
  return value;
}
