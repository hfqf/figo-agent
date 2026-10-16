import { describe, expect, it } from "vitest";
import { evaluateCompactionPolicy } from "../../src/context/compaction-policy.js";

const config = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

describe("evaluateCompactionPolicy", () => {
  it("matches the exact Pi window boundary instead of legacy turn or character thresholds", () => {
    expect(evaluateCompactionPolicy({ contextTokens: 111616, contextWindow: 128000 }, config).trigger).toBe(false);
    expect(evaluateCompactionPolicy({ contextTokens: 111617, contextWindow: 128000 }, config).trigger).toBe(true);
  });
  it("honors the automatic switch", () => {
    expect(evaluateCompactionPolicy({ contextTokens: 999999, contextWindow: 128000 }, { ...config, enabled: false }).trigger).toBe(false);
  });
  it("does not invent a window for an unknown endpoint", () => {
    expect(evaluateCompactionPolicy({ contextTokens: 999999 }, config)).toMatchObject({ trigger: false, reason: "model_context_unknown" });
  });
});
