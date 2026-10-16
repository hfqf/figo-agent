// 固定上游：earendil-works/pi@6a1f799b675c8cb98320b71ff7ee44f160fe8d66。
// 对照 compaction.ts 的纯算法；宿主条目适配单独验证，不涉及 Store/Loop。
import { describe, expect, it } from "vitest";
import { readPiCompactionSettings } from "../../src/config/pi-compaction-settings.js";
import {
  calculateContextTokens,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findProjectedCutPoint,
  findTurnStartIndex,
  shouldCompact,
  type PiMessage,
  type PiProjectedEntry,
  type PiSessionEntry,
  type PiUsage
} from "../../src/context/pi-compaction.js";

function usage(input: number, output = 0, cacheRead = 0, cacheWrite = 0): PiUsage {
  return { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite };
}
function user(text = "user"): PiMessage { return { role: "user", content: text }; }
function assistant(text = "text", actual?: PiUsage, stopReason = "stop"): PiMessage {
  return { role: "assistant", content: [{ type: "text", text }], usage: actual, stopReason };
}
function message(id: string, value: PiMessage): PiSessionEntry { return { type: "message", id, message: value }; }
function project(sourceEntry: PiSessionEntry, messages?: PiMessage[]): PiProjectedEntry {
  return { sourceEntry, messages: messages ?? (sourceEntry.type === "message" ? [sourceEntry.message] : []) };
}
function omission(targetId: string): PiProjectedEntry {
  return project({ type: "context_edit", id: `omit-${targetId}`, targetId, replacement: null });
}
const toolCall: PiMessage = {
  role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: { path: "big.txt" } }]
};
const largeToolResult: PiMessage = {
  role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "x".repeat(8000) }]
};

describe("固定 Pi token 算法符合性", () => {
  it("实际 totalTokens 优先，否则合计四类用量", () => {
    expect(calculateContextTokens({ ...usage(1000, 500, 200, 100), totalTokens: 9999 })).toBe(9999);
    expect(calculateContextTokens({ ...usage(1000, 500, 200, 100), totalTokens: 0 })).toBe(1800);
    expect(calculateContextTokens(usage(0))).toBe(0);
  });

  it.each([
    [111615, false], [111616, false], [111617, true]
  ])("128000 窗口与 16384 预留严格大于阈值：%i", (tokens, expected) => {
    expect(shouldCompact(tokens, 128000, readPiCompactionSettings(undefined))).toBe(expected);
  });

  it("禁用时不触发压缩", () => {
    expect(shouldCompact(200000, 128000, readPiCompactionSettings({ enabled: false }))).toBe(false);
  });

  it.each([["", 0], ["x", 1], ["xxxx", 1], ["xxxxx", 2], ["中文字符估算", 2]])(
    "字符估算按 JS 字符串长度除以四向上取整：%s", (text, expected) => {
      expect(estimateTokens(user(text))).toBe(expected);
    }
  );

  it("system 合计正文、sections 和 toolsAdded 的 JSON 字符数", () => {
    expect(estimateTokens({ role: "system", content: "abcd", sections: { a: "1234", b: "", c: undefined },
      toolsAdded: [{ name: "read" }] })).toBe(7);
    expect(estimateTokens({ role: "system", content: [{ type: "text", text: "abcde" }] })).toBe(2);
  });

  it("正文中的图片固定按 4800 字符计，文本块合计后取整", () => {
    const content = [{ type: "text" as const, text: "a" }, { type: "text" as const, text: "b" },
      { type: "image" as const, data: "ignored", mimeType: "image/png" }];
    for (const role of ["user", "custom", "toolResult"] as const) {
      expect(estimateTokens({ role, content })).toBe(1201);
    }
  });

  it("assistant 计算 text、thinking、工具名与参数 JSON，忽略实际 usage", () => {
    expect(estimateTokens({ role: "assistant", usage: usage(99999), content: [
      { type: "text", text: "abcd" }, { type: "thinking", thinking: "12345" },
      { type: "toolCall", name: "read", arguments: { path: "a" } }
    ] })).toBe(7);
  });

  it("custom、bash 和两类 summary 使用对应内容估算", () => {
    expect(estimateTokens({ role: "custom", content: "abcde" })).toBe(2);
    expect(estimateTokens({ role: "bashExecution", command: "ls", output: "abc" })).toBe(2);
    expect(estimateTokens({ role: "branchSummary", summary: "abcde" })).toBe(2);
    expect(estimateTokens({ role: "compactionSummary", summary: "abcde" })).toBe(2);
  });

  it("无有效 usage 时仅返回估算量与未知锚点，不伪造实际用量", () => {
    expect(estimateContextTokens([user(), assistant()])).toEqual({
      tokens: 2, usageTokens: 0, trailingTokens: 2, lastUsageIndex: null
    });
    expect(estimateContextTokens([])).toEqual({ tokens: 0, usageTokens: 0, trailingTokens: 0, lastUsageIndex: null });
  });

  it("使用最近有效 assistant usage，加上其后的消息估算", () => {
    expect(estimateContextTokens([user("x".repeat(400)), assistant("a", usage(10)),
      user(), assistant("text", usage(20, 3, 4, 5)), user("abcde"), { role: "custom", content: "abcd" }])).toEqual({
      tokens: 35, usageTokens: 32, trailingTokens: 3, lastUsageIndex: 3
    });
  });

  it.each(["error", "aborted"])("跳过 %s 响应的非零 usage，但估算其尾部文本", (stopReason) => {
    expect(estimateContextTokens([assistant("a", usage(100, 50)), user(), assistant("text", usage(9999), stopReason)]))
      .toEqual({ tokens: 152, usageTokens: 150, trailingTokens: 2, lastUsageIndex: 0 });
    expect(estimateContextTokens([user(), assistant("text", usage(9999), stopReason)]))
      .toEqual({ tokens: 2, usageTokens: 0, trailingTokens: 2, lastUsageIndex: null });
  });

  it("全零 usage 不是有效锚点，缺省 usage 同样回退估算", () => {
    expect(estimateContextTokens([assistant("text", usage(100)), user(), assistant("text", usage(0))]))
      .toEqual({ tokens: 102, usageTokens: 100, trailingTokens: 2, lastUsageIndex: 0 });
    expect(estimateContextTokens([assistant("text", usage(0))]))
      .toEqual({ tokens: 1, usageTokens: 0, trailingTokens: 1, lastUsageIndex: null });
  });

  it("length 响应与零 totalTokens 下的非零分量仍按上游保留有效 usage", () => {
    expect(estimateContextTokens([assistant("text", { ...usage(10, 2, 3, 4), totalTokens: 0 }, "length")]))
      .toEqual({ tokens: 19, usageTokens: 19, trailingTokens: 0, lastUsageIndex: 0 });
  });
});

describe.each(["raw", "projected"] as const)("固定 Pi 安全切点符合性：%s", (mode) => {
  function cut(entries: PiSessionEntry[], keep: number, start = 0, end = entries.length) {
    return mode === "raw" ? findCutPoint(entries, start, end, keep)
      : findProjectedCutPoint(entries.map((entry) => project(entry)), start, end, keep);
  }

  it.each([[0, 3], [1, 3], [2, 2], [3, 1], [4, 0], [5, 0]])(
    "达到近期预算即停，预算 %i", (keep, index) => {
      const entries = [message("u1", user()), message("a1", assistant()), message("u2", user()), message("a2", assistant())];
      expect(cut(entries, keep)).toEqual({ firstKeptEntryIndex: index,
        turnStartIndex: index === 3 ? 2 : index === 1 ? 0 : -1, isSplitTurn: index === 3 || index === 1 });
    }
  );

  it("没有合法切点时返回 startIndex；空区间同样如此", () => {
    const entries: PiSessionEntry[] = [{ type: "metadata", id: "meta" }, message("result", largeToolResult)];
    expect(cut(entries, 1, 1)).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
    expect(cut(entries, 1, 1, 1)).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("限定 startIndex 和排他 endIndex，不引入区间外 Turn 起点", () => {
    const entries = [message("u", user()), message("a1", assistant()), message("a2", assistant("x".repeat(1000)))];
    expect(cut(entries, 1, 1, 2)).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("超大工具尾部保留最近的 assistant 工具调用，不退回首条历史", () => {
    const entries = [message("old-u", user()), message("old-a", assistant()), message("current-u", user()),
      message("call", toolCall), message("result", largeToolResult)];
    expect(cut(entries, 1000)).toEqual({ firstKeptEntryIndex: 3, turnStartIndex: 2, isSplitTurn: true });
  });

  it("预算落在工具结果时优先其后的合法切点", () => {
    const entries = [message("u", user()), message("call", toolCall), message("result", largeToolResult),
      message("answer", assistant())];
    expect(cut(entries, 10)).toEqual({ firstKeptEntryIndex: 3, turnStartIndex: 0, isSplitTurn: true });
  });

  it("单个用户的长工具交互允许在 assistant 处拆分", () => {
    const entries = [message("u", user()), message("call", toolCall), message("result", largeToolResult),
      message("answer", assistant("done"))];
    expect(cut(entries, 1)).toEqual({ firstKeptEntryIndex: 3, turnStartIndex: 0, isSplitTurn: true });
  });

  it("回收切点前紧邻的 metadata，保持上游 split 判定", () => {
    const entries: PiSessionEntry[] = [message("u", user()), { type: "metadata", id: "m1" },
      { type: "metadata", id: "m2" }, message("answer", assistant())];
    expect(cut(entries, 1)).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: 0, isSplitTurn: true });
  });

  it("metadata 回扫不能越过 compaction 边界", () => {
    const entries: PiSessionEntry[] = [message("u", user()), { type: "compaction", id: "compact", summary: "old" },
      { type: "metadata", id: "meta" }, message("answer", assistant())];
    expect(cut(entries, 1)).toEqual({ firstKeptEntryIndex: 2, turnStartIndex: 0, isSplitTurn: true });
  });

  it("system 计入预算但不能作切点或 Turn 起点", () => {
    const entries = [message("system", { role: "system", content: "xxxx" }), message("answer", assistant())];
    expect(cut(entries, 1)).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });

  it("零长度消息不提前终止回扫", () => {
    const entries = [message("u", user()), message("empty", assistant(""))];
    expect(cut(entries, 0)).toEqual({ firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
  });

  it.each<PiMessage>([
    { role: "custom", content: "xxxx" }, { role: "bashExecution", command: "ls", output: "xx" },
    { role: "branchSummary", summary: "xxxx" }, { role: "compactionSummary", summary: "xxxx" }
  ])("用户类 $role 消息能作切点与 Turn 起点", (value) => {
    const entries = [message("old", user()), message("custom", value), message("answer", assistant())];
    expect(cut(entries, 1)).toEqual({ firstKeptEntryIndex: 2, turnStartIndex: 1, isSplitTurn: true });
    expect(cut(entries, 2)).toEqual({ firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false });
  });
});

describe("宿主条目适配与投影恢复后缀", () => {
  const longUser = message("input", user("x".repeat(400)));
  const failed = message("failed", assistant("failure", usage(9999), "error"));

  it("findTurnStartIndex 不把 compaction、metadata 和 context_edit 作为起点", () => {
    const entries: PiSessionEntry[] = [message("u", user()), { type: "compaction", id: "c", summary: "xxxx" },
      { type: "metadata", id: "m" }, { type: "context_edit", id: "edit", targetId: "u", replacement: user() }];
    expect(findTurnStartIndex(entries, 3, 0)).toBe(0);
    expect(findTurnStartIndex(entries, 3, 1)).toBe(-1);
  });

  it("有 summary 的原始 compaction 贡献摘要 token，但本身不是切点", () => {
    const entries: PiSessionEntry[] = [message("old", user()),
      { type: "compaction", id: "c", summary: "x".repeat(400) }, message("new", user())];
    expect(findCutPoint(entries, 0, entries.length, 10)).toEqual({
      firstKeptEntryIndex: 2, turnStartIndex: -1, isSplitTurn: false
    });
    expect(findCutPoint([message("old", user()), { type: "compaction", id: "c" }, message("new", user())], 0, 3, 10))
      .toEqual({ firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false });
  });

  it("按投影消息而非原始消息估算，支持一项投影贡献多条消息", () => {
    const entries = [project(message("old", user())), project(longUser, [user(), assistant()]),
      project(message("latest", assistant()))];
    expect(findProjectedCutPoint(entries, 0, entries.length, 3)).toEqual({
      firstKeptEntryIndex: 1, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("闭合 omitted assistant 加 null context_edit 后缀在达到预算时前移一项", () => {
    const entries = [project(longUser), project(failed, []), omission("failed")];
    expect(findProjectedCutPoint(entries, 0, entries.length, 100)).toEqual({
      firstKeptEntryIndex: 1, turnStartIndex: 0, isSplitTurn: true
    });
  });

  it("未达到预算时不前移恢复后缀", () => {
    const entries = [project(longUser), project(failed, []), omission("failed")];
    expect(findProjectedCutPoint(entries, 0, entries.length, 101)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("普通 metadata 后缀不误吞尚未发送的用户输入", () => {
    const entries = [project(longUser), project({ type: "metadata", id: "meta" }), omission("older")];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("仅 omitted user 后缀不触发 assistant 恢复逻辑", () => {
    const entries = [project(longUser), project(message("omitted-user", user()), []), omission("omitted-user")];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("后缀存在可见的未发送输入时保留该输入", () => {
    const entries = [project(longUser), project(failed, []), omission("failed"),
      project(message("unsent", user("new!")))];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 1, turnStartIndex: 0, isSplitTurn: true
    });
    expect(entries.slice(1).flatMap((entry) => entry.messages)).toEqual([user("new!")]);
  });

  it("非空 replacement 修改后缀外目标时不前移", () => {
    const entries = [project(longUser), project(failed, []), omission("failed"),
      project({ type: "context_edit", id: "replace", targetId: "input", replacement: user("replacement") })];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("replacement 目标属于 omitted 后缀时按上游允许前移", () => {
    const entries = [project(longUser), project(failed, []),
      project({ type: "context_edit", id: "replace", targetId: "failed", replacement: assistant("replacement") }),
      omission("failed")];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 1, turnStartIndex: 0, isSplitTurn: true
    });
  });

  it("恢复后缀不得跨过 compaction，即使该条目贡献为空", () => {
    const entries = [project(longUser), project(failed, []), omission("failed"),
      project({ type: "compaction", id: "c" })];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("恢复后缀判断尊重 endIndex，不读取区间外失败尝试", () => {
    const entries = [project(longUser), project({ type: "metadata", id: "meta" }), project(failed, []), omission("failed")];
    expect(findProjectedCutPoint(entries, 0, 2, 1)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("省略全部可见消息时返回 startIndex", () => {
    const entries = [project(longUser, []), project(failed, []), omission("failed")];
    expect(findProjectedCutPoint(entries, 0, entries.length, 1)).toEqual({
      firstKeptEntryIndex: 0, turnStartIndex: -1, isSplitTurn: false
    });
  });

  it("算法不修改原始条目与已构建投影", () => {
    const entries = [project(longUser), project(failed, []), omission("failed")];
    const before = structuredClone(entries);
    findProjectedCutPoint(entries, 0, entries.length, 1);
    findCutPoint(entries.map((entry) => entry.sourceEntry), 0, entries.length, 1);
    estimateContextTokens(entries.flatMap((entry) => entry.messages));
    expect(entries).toEqual(before);
  });
});
