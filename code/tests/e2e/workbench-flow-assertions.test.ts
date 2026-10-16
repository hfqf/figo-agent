import { describe, expect, it } from "vitest";
import { assertPayableAmount } from "../../e2e/workbench-flow-assertions.js";

describe("workbench payable amount acceptance", () => {
  it("accepts an exact standalone numeric amount", () => {
    expect(() => assertPayableAmount("projectCode：test\n实付金额：420", 420)).not.toThrow();
    expect(() => assertPayableAmount("说明\n实付金额: 493.00\n", 493)).not.toThrow();
    expect(() => assertPayableAmount("projectCode 是 test，实付金额为 420。\n420", 420)).not.toThrow();
  });

  it("rejects wrong amounts which contain the expected digits", () => {
    for (const value of [1420, 4200, 420.5]) expect(() => assertPayableAmount(`实付金额：${value}`, 420)).toThrow();
    expect(() => assertPayableAmount("实付金额：1493", 493)).toThrow();
  });

  it("does not mistake a calculation or an earlier correct field for the final amount", () => {
    expect(() => assertPayableAmount("73 × 6 − 18 = 420，实付金额：1420", 420)).toThrow();
    expect(() => assertPayableAmount("实付金额：420\n实付金额：1420", 420)).toThrow();
  });
});
