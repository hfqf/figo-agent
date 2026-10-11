import { describe, expect, it } from "vitest";
import { parseCompactionSummary } from "../../src/context/compaction-summary.js";

const valid = JSON.stringify({
  goal: { text: "完成部署评估", sourceTurnIds: ["turn_1"] },
  facts: [{ text: "arm64", sourceTurnIds: ["turn_1"] }],
  decisions: [], completedWork: [], openIssues: [], constraints: [],
  sourceTurnIds: ["turn_1"]
});

describe("parseCompactionSummary", () => {
  it("accepts sourced structured summaries", () => {
    expect(parseCompactionSummary(valid, ["turn_1"], 12000).goal.text).toBe("完成部署评估");
  });
  it("accepts a JSON summary following a complete model thinking block", () => {
    const response = `<think>先分析 {not json}，不属于最终答复。</think>\n\n\`\`\`json\n${valid}\n\`\`\``;
    expect(parseCompactionSummary(response, ["turn_1"], 12000).goal.text).toBe("完成部署评估");
  });
  it("does not strip literal thinking tags inside JSON facts", () => {
    const literal = JSON.stringify({ ...JSON.parse(valid), facts: [{ text: "项目代码包含 <think>literal</think> 标签", sourceTurnIds: ["turn_1"] }] });
    expect(parseCompactionSummary(literal, ["turn_1"], 12000).facts[0].text).toContain("<think>literal</think>");
  });
  it("rejects invalid JSON, wrong provenance, and oversized content", () => {
    expect(() => parseCompactionSummary("本地占位响应", ["turn_1"], 12000)).toThrow();
    expect(() => parseCompactionSummary(valid, ["turn_2"], 12000)).toThrow();
    expect(() => parseCompactionSummary(valid, ["turn_1"], 10)).toThrow();
  });
  it("rejects duplicate aggregate source IDs", () => {
    const duplicated = JSON.stringify({ ...JSON.parse(valid), sourceTurnIds: ["turn_1", "turn_1"] });
    expect(() => parseCompactionSummary(duplicated, ["turn_1", "turn_2"], 12000)).toThrow();
  });
  it("accepts cited IDs as a subset of a long checkpoint coverage range", () => {
    const coveredIds = ["turn_1", ...Array.from({ length: 300 }, (_, index) => `turn_${index + 2}`)];
    expect(parseCompactionSummary(valid, coveredIds, 12000).sourceTurnIds).toEqual(["turn_1"]);
  });
});
