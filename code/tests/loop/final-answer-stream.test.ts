import { describe, expect, it } from "vitest";
import { FinalAnswerStream, hasFinalMarker } from "../../src/loop/final-answer-stream.js";

describe("FinalAnswerStream", () => {
  it("emits marked final text incrementally without exposing the marker", () => {
    const chunks: string[] = [];
    const stream = new FinalAnswerStream((delta) => chunks.push(delta));
    for (const part of ["FI", "NAL\n你", "好"]) stream.push(part);
    expect(chunks).toEqual(["你", "好"]);
    expect(stream.finish("FINAL\n你好", true)).toBe("你好");
    expect(chunks.join("")).toBe("你好");
  });

  it("holds tool-call JSON until the loop classifies it", () => {
    const chunks: string[] = [];
    const stream = new FinalAnswerStream((delta) => chunks.push(delta));
    stream.push("```json\n{\"type\":\"tool_calls\"}");
    expect(stream.finish("```json\n{\"type\":\"tool_calls\"}", false)).toContain("tool_calls");
    expect(chunks).toEqual([]);
  });

  it("skips a complete leading think block and keeps the answer stream", () => {
    const chunks: string[] = [];
    const stream = new FinalAnswerStream((delta) => chunks.push(delta));
    for (const part of ["<think>内", "部</think>\nFI", "NAL\n结", "果"]) stream.push(part);
    expect(chunks).toEqual(["结", "果"]);
    expect(hasFinalMarker("<think>内部</think>\nFINAL\n结果")).toBe(true);
    expect(stream.finish("<think>内部</think>\nFINAL\n结果", true)).toBe("结果");
  });

  it("falls back to the complete answer when a provider omits the marker", () => {
    const chunks: string[] = [];
    const stream = new FinalAnswerStream((delta) => chunks.push(delta));
    stream.push("普通答复");
    expect(stream.finish("普通答复", true)).toBe("普通答复");
    expect(chunks).toEqual(["普通答复"]);
  });

  it("streams unmarked native final text without duplicating it at completion", () => {
    const chunks: string[] = [];
    const stream = new FinalAnswerStream((delta) => chunks.push(delta), true);
    stream.push("根项目");
    stream.push("已分析");
    expect(stream.finish("根项目已分析", true)).toBe("根项目已分析");
    expect(chunks).toEqual(["根项目", "已分析"]);
  });

  it("holds native XML tool syntax until the loop validates it", () => {
    const chunks: string[] = [];
    const stream = new FinalAnswerStream((delta) => chunks.push(delta), true);
    stream.push("<tool");
    stream.push('_calls><invoke name="system_info"></invoke></tool_calls>');
    expect(stream.finish('<tool_calls><invoke name="system_info"></invoke></tool_calls>', false))
      .toContain("tool_calls");
    expect(chunks).toEqual([]);
  });
});
