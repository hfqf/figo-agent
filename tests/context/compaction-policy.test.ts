import { describe, expect, it } from "vitest";
import { evaluateCompactionPolicy } from "../../src/context/compaction-policy.js";

const config = { autoEnabled: true, turnThreshold: 12, charThreshold: 24000, summaryMaxChars: 12000 };

describe("evaluateCompactionPolicy", () => {
  it("triggers by either turn count or character count without a provider name", () => {
    expect(evaluateCompactionPolicy({ turnCount: 11, charCount: 1000 }, config).trigger).toBe(false);
    expect(evaluateCompactionPolicy({ turnCount: 12, charCount: 1000 }, config).trigger).toBe(true);
    expect(evaluateCompactionPolicy({ turnCount: 2, charCount: 24000 }, config).trigger).toBe(true);
  });
  it("honors the automatic switch", () => {
    expect(evaluateCompactionPolicy({ turnCount: 100, charCount: 999999 }, { ...config, autoEnabled: false }).trigger).toBe(false);
  });
});
