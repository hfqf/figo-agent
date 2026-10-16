import { describe, expect, it } from "vitest";
import {
  readPiCompactionSettings,
  resolvePiCompactionSettings,
  type PiCompactionSettings
} from "../../src/config/pi-compaction-settings.js";

const defaults: PiCompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  summaryToolResultMaxChars: 2000,
  modelOverrides: {}
};
const invalidIntegers = [NaN, Infinity, -Infinity, "1024", -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null, true];

describe("Pi 压缩配置读取", () => {
  it.each([undefined, null, {}])("缺省配置使用 Pi 默认值：%j", (value) => {
    expect(readPiCompactionSettings(value)).toEqual(defaults);
  });

  it.each([false, 0, "", [], "config"])("拒绝非对象配置：%j", (value) => {
    expect(() => readPiCompactionSettings(value)).toThrow("压缩配置 必须是对象");
  });

  it("兼容旧开关，但不把旧轮数、字符阈值和摘要长度转成容量", () => {
    expect(readPiCompactionSettings({
      autoEnabled: false, turnThreshold: 3, charThreshold: 500, summaryMaxChars: 100
    })).toEqual({ ...defaults, enabled: false });
  });

  it.each([true, false])("显式 enabled=%j 优先于旧开关", (enabled) => {
    expect(readPiCompactionSettings({ enabled, autoEnabled: !enabled }).enabled).toBe(enabled);
    expect(readPiCompactionSettings({ enabled, autoEnabled: "ignored" }).enabled).toBe(enabled);
  });

  it("只有缺省 enabled 才回退 autoEnabled", () => {
    expect(readPiCompactionSettings({ enabled: undefined, autoEnabled: false }).enabled).toBe(false);
  });

  it.each([null, 0, "false", [], {}])("拒绝非法 enabled 且不回退旧开关：%j", (enabled) => {
    expect(() => readPiCompactionSettings({ enabled, autoEnabled: true })).toThrow("enabled 必须是布尔值");
  });

  it.each([null, 0, "false", [], {}])("拒绝作为缺省来源的非法 autoEnabled：%j", (autoEnabled) => {
    expect(() => readPiCompactionSettings({ autoEnabled })).toThrow("autoEnabled 必须是布尔值");
  });

  it("保留零容量、正整数预览长度和最大安全整数", () => {
    expect(readPiCompactionSettings({ reserveTokens: 0, keepRecentTokens: Number.MAX_SAFE_INTEGER,
      summaryToolResultMaxChars: 1 })).toEqual({ ...defaults, reserveTokens: 0,
      keepRecentTokens: Number.MAX_SAFE_INTEGER, summaryToolResultMaxChars: 1 });
    expect(readPiCompactionSettings({ keepRecentTokens: 0 }).keepRecentTokens).toBe(0);
  });

  for (const field of ["reserveTokens", "keepRecentTokens", "summaryToolResultMaxChars"] as const) {
    it.each(invalidIntegers)(`拒绝非法 ${field}：%j`, (value) => {
      expect(() => readPiCompactionSettings({ [field]: value })).toThrow(
        `${field} 必须是${field === "summaryToolResultMaxChars" ? "正" : "非负"}安全整数`
      );
    });
  }

  it("工具结果预览长度不能为零", () => {
    expect(() => readPiCompactionSettings({ summaryToolResultMaxChars: 0 })).toThrow(
      "summaryToolResultMaxChars 必须是正安全整数"
    );
  });

  it("各字段 undefined 逐项使用缺省值", () => {
    expect(readPiCompactionSettings({ enabled: undefined, reserveTokens: undefined,
      keepRecentTokens: undefined, summaryToolResultMaxChars: undefined, modelOverrides: undefined })).toEqual(defaults);
  });

  it.each([null, [], 1, "provider/model", false])("拒绝非对象 modelOverrides：%j", (modelOverrides) => {
    expect(() => readPiCompactionSettings({ modelOverrides })).toThrow("modelOverrides 必须是对象");
  });

  it.each([undefined, null, [], 1, "override", false])("拒绝非对象覆盖条目：%j", (entry) => {
    expect(() => readPiCompactionSettings({ modelOverrides: { "provider/model": entry } })).toThrow(
      "modelOverrides[provider/model] 必须是对象"
    );
  });

  for (const field of ["reserveTokens", "keepRecentTokens"] as const) {
    it.each(invalidIntegers)(`拒绝非法覆盖 ${field}：%j`, (value) => {
      expect(() => readPiCompactionSettings({ modelOverrides: { "provider/model": { [field]: value } } })).toThrow(
        `modelOverrides[provider/model].${field} 必须是非负安全整数`
      );
    });
  }

  it("覆盖仅保留 R/K，不替缺省覆盖填入全局值", () => {
    expect(readPiCompactionSettings({ modelOverrides: {
      "provider/model": { reserveTokens: 0, keepRecentTokens: undefined, enabled: false,
        summaryToolResultMaxChars: 1 },
      "provider/other": { keepRecentTokens: Number.MAX_SAFE_INTEGER },
      "other/model": {}
    } }).modelOverrides).toEqual({
      "provider/model": { reserveTokens: 0 },
      "provider/other": { keepRecentTokens: Number.MAX_SAFE_INTEGER },
      "other/model": {}
    });
  });

  it("每次读取产生独立的覆盖对象，不修改输入", () => {
    const input = { modelOverrides: { "provider/model": { reserveTokens: 10 } } };
    const result = readPiCompactionSettings(input);
    result.modelOverrides["provider/model"].reserveTokens = 20;
    expect(input.modelOverrides["provider/model"].reserveTokens).toBe(10);
    const first = readPiCompactionSettings(undefined);
    first.modelOverrides["provider/model"] = {};
    expect(readPiCompactionSettings(undefined)).toEqual(defaults);
  });
});

describe("Pi 压缩配置模型覆盖", () => {
  const config: PiCompactionSettings = {
    enabled: false, reserveTokens: 100, keepRecentTokens: 200, summaryToolResultMaxChars: 300,
    modelOverrides: {
      "provider/model": { reserveTokens: 10, keepRecentTokens: 20 },
      "provider/reserve-only": { reserveTokens: 0 },
      "provider/recent-only": { keepRecentTokens: 0 },
      "provider/empty": {}
    }
  };

  it.each([
    ["provider", "model", 10, 20],
    ["provider", "reserve-only", 0, 200],
    ["provider", "recent-only", 100, 0],
    ["provider", "empty", 100, 200],
    ["other", "model", 100, 200],
    ["Provider", "model", 100, 200],
    ["provider", "Model", 100, 200],
    ["provider ", "model", 100, 200],
    ["provider", "model ", 100, 200],
    ["provider", "model-extra", 100, 200]
  ])("精确匹配 %s/%s 并逐项回退", (providerId, modelId, reserveTokens, keepRecentTokens) => {
    expect(resolvePiCompactionSettings(config, providerId, modelId)).toEqual({
      enabled: false, reserveTokens, keepRecentTokens, summaryToolResultMaxChars: 300
    });
  });

  it("解析覆盖不修改传入配置", () => {
    const before = structuredClone(config);
    resolvePiCompactionSettings(config, "provider", "model");
    expect(config).toEqual(before);
  });

  it.each(["reserveTokens", "keepRecentTokens", "summaryToolResultMaxChars"] as const)(
    "即使覆盖合法，也拒绝非法全局 %s", (field) => {
      const invalid = { ...config, [field]: NaN };
      expect(() => resolvePiCompactionSettings(invalid, "provider", "model")).toThrow(`${field} 必须是`);
    }
  );

  it("解析时也校验 enabled", () => {
    const invalid = { ...config, enabled: "false" } as unknown as PiCompactionSettings;
    expect(() => resolvePiCompactionSettings(invalid, "provider", "model")).toThrow("enabled 必须是布尔值");
  });

  it("即使未选中也拒绝非法覆盖条目", () => {
    const invalid = { ...config, modelOverrides: { "other/model": { reserveTokens: -1 } } };
    expect(() => resolvePiCompactionSettings(invalid, "provider", "model")).toThrow(
      "modelOverrides[other/model].reserveTokens 必须是非负安全整数"
    );
  });
});
