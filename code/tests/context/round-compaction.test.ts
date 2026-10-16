import { describe, expect, it } from "vitest";
import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse, LLMUsage } from "../../src/contracts/types.js";
import type { ConversationMessage } from "../../src/context/conversation-message.js";
import { prepareConversationCompaction } from "../../src/context/compaction-preparation.js";
import { generatePiSummary } from "../../src/context/pi-summary.js";

const markdown = "## Goal\n分析当前项目。\n\n## Constraints & Preferences\n保持工具批次完整。\n\n## Progress\n### Done\n- [x] 已读取文件。\n### In Progress\n- [ ] 继续分析。\n### Blocked\n- 无。\n\n## Key Decisions\n使用真实工具结果。\n\n## Next Steps\n继续分析。\n\n## Critical Context\nREADME.md";
const entry = (id: string, message: LLMMessage): ConversationMessage => ({ sourceRef: id, turnId: "turn", message });
const user = (content = "分析当前项目"): ConversationMessage => entry("user", { role: "user", content });
const base = { sessionId: "session", taskId: "task", turnId: "turn", model: "selected-model",
  reserveTokens: 16384, summaryToolResultMaxChars: 2000, history: [user()], turnPrefix: [] as ConversationMessage[] };
const actual: LLMUsage = { input: 100, output: 20, cacheRead: 3, cacheWrite: 4, totalTokens: 127 };

function provider(outputs: Array<Partial<LLMResponse> | Error> = [{ content: markdown }]) {
  const requests: LLMRequest[] = [];
  const callbacks: unknown[] = [];
  const llm: LLMProvider = {
    complete: async (request, callback) => {
      requests.push(request);
      callbacks.push(callback);
      const output = outputs[requests.length - 1] ?? { content: markdown };
      if (output instanceof Error) throw output;
      return { id: "response", requestId: request.id, model: request.model, content: markdown,
        finishReason: "stop", outputLength: markdown.length, durationMs: 1, ...output };
    }
  };
  return { llm, requests, callbacks };
}

describe("Pi 独立摘要生成", () => {
  it("普通摘要使用 .8R 输出预算、选中模型、请求归属且无工具和流式", async () => {
    const { llm, requests, callbacks } = provider([{ content: markdown, usage: actual }]);
    const controller = new AbortController();
    const result = await generatePiSummary(llm, { ...base, usageTurnId: "usage-turn",
      maxTokensField: "max_completion_tokens", signal: controller.signal });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ sessionId: "session", taskId: "task", turnId: "turn",
      usageTurnId: "usage-turn", purpose: "task_compaction", model: "selected-model", maxOutputTokens: 13107,
      maxTokensField: "max_completion_tokens", signal: controller.signal });
    expect(requests[0]).not.toHaveProperty("availableTools");
    expect(callbacks).toEqual([undefined]);
    expect(requests[0].id).toMatch(/^llm_req_/);
    expect(result).toEqual({ summaryMarkdown: markdown, requestId: requests[0].id,
      requestIds: [requests[0].id], readFiles: [], modifiedFiles: [], usage: actual });
    expect(requests[0].messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(requests[0].messages[0].content).toContain("中文");
    for (const heading of ["## Goal", "## Constraints & Preferences", "## Progress", "### Done",
      "### In Progress", "### Blocked", "## Key Decisions", "## Next Steps", "## Critical Context"]) {
      expect(requests[0].messages[1].content).toContain(heading);
    }
  });

  it.each([[100, 100], [0, 13107], [undefined, 13107]])(
    "按模型最大输出能力 %s 夹紧普通预算", async (maxTokens, expected) => {
      const { llm, requests } = provider();
      await generatePiSummary(llm, { ...base, maxTokens });
      expect(requests[0].maxOutputTokens).toBe(expected);
      expect(requests[0].usageTurnId).toBeNull();
    }
  );

  it("滚动摘要携带旧摘要、当前历史和关注点，保留完整原始目标", async () => {
    const { llm, requests } = provider();
    const goal = "原始目标：" + "完整保留用户约束".repeat(500);
    await generatePiSummary(llm, { ...base, history: [user(goal)], previousSummary: "旧摘要",
      instructions: "特别关注配置与回归测试" });
    const prompt = requests[0].messages[1].content;
    expect(prompt).toContain("[User]: " + goal);
    expect(prompt).toContain("<previous-summary>\n旧摘要\n</previous-summary>");
    expect(prompt).toContain("特别关注配置与回归测试");
    expect(prompt).toContain("保留");
    expect(prompt).toContain("更新");
    expect(prompt).not.toContain("sourceTurnIds");
  });

  it("split 分别生成历史与前缀，按上游顺序合并并汇总实际 usage", async () => {
    const { llm, requests } = provider([{ content: "历史摘要", usage: actual }, { content: "前缀摘要", usage: actual }]);
    const result = await generatePiSummary(llm, { ...base, history: [user("旧历史")],
      turnPrefix: [user("当前目标")], previousSummary: "已有摘要", instructions: "聚焦测试" });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.maxOutputTokens)).toEqual([13107, 8192]);
    expect(requests.every((request) => request.purpose === "task_compaction")).toBe(true);
    expect(new Set(requests.map((request) => request.id)).size).toBe(2);
    expect(requests[0].messages[1].content).toContain("旧历史");
    expect(requests[0].messages[1].content).toContain("已有摘要");
    expect(requests[1].messages[1].content).toContain("当前目标");
    expect(requests[1].messages[1].content).not.toContain("旧历史");
    expect(requests[1].messages[1].content).toContain("## Original Request");
    expect(requests[1].messages[1].content).toContain("## Progress So Far");
    expect(requests[1].messages[1].content).toContain("## Context Needed to Continue");
    expect(result.summaryMarkdown).toBe("历史摘要\n\n---\n\n**Turn Context (split turn):**\n\n前缀摘要");
    expect(result.requestId).toBe(requests[1].id);
    expect(result.requestIds).toEqual(requests.map((request) => request.id));
    expect(result.usage).toEqual({ input: 200, output: 40, cacheRead: 6, cacheWrite: 8, totalTokens: 254 });
  });

  it.each([[undefined, 8192], [300, 300]])(
    "只有 split 前缀时复用旧摘要，前缀预算按 .5R 并夹紧 %s", async (maxTokens, expected) => {
      const { llm, requests } = provider([{ content: "前缀摘要" }]);
      const result = await generatePiSummary(llm, { ...base, history: [], turnPrefix: [user()],
        previousSummary: "已有摘要", maxTokens });
      expect(requests).toHaveLength(1);
      expect(requests[0].maxOutputTokens).toBe(expected);
      expect(result.summaryMarkdown).toContain("已有摘要\n\n---");
      expect(result.summaryMarkdown).toContain("前缀摘要");
      expect(result.usage).toBeUndefined();
    }
  );

  it("没有旧摘要与历史时仍可总结单次长交互前缀", async () => {
    const { llm } = provider([{ content: "前缀摘要" }]);
    expect((await generatePiSummary(llm, { ...base, history: [], turnPrefix: [user()] })).summaryMarkdown)
      .toContain("前缀摘要");
  });

  it("split 有任一请求 usage 未知时不冒充完整总用量", async () => {
    const { llm } = provider([{ content: "历史", usage: actual }, { content: "前缀" }]);
    expect((await generatePiSummary(llm, { ...base, turnPrefix: [user()] })).usage).toBeUndefined();
  });

  it("显式全零 usage 保留为 Provider 实际返回值", async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
    const { llm } = provider([{ content: markdown, usage: zero }]);
    expect((await generatePiSummary(llm, base)).usage).toEqual(zero);
  });

  it("assistant 文本先移除思考块，再序列化可见内容与原生工具参数", async () => {
    const { llm, requests } = provider();
    const history = [user(), entry("a", { role: "assistant",
      content: "<think>不得发送的推理</think>\n<thinking>第二段推理</thinking>\n可见进度",
      toolCalls: [{ id: "c", name: "read_file", input: { path: "README.md", offset: 1 } }] })];
    await generatePiSummary(llm, { ...base, history });
    const prompt = requests[0].messages[1].content;
    expect(prompt).not.toContain("不得发送的推理");
    expect(prompt).not.toContain("第二段推理");
    expect(prompt).toContain("[Assistant]: 可见进度");
    expect(prompt).toContain('[Assistant tool calls]: read_file(path="README.md", offset=1)');
    expect(prompt).not.toContain('"sourceRef"');
  });

  it("未闭合 assistant 思考块不进入摘要请求", async () => {
    const { llm, requests } = provider();
    await generatePiSummary(llm, { ...base, history: [user(), entry("a", { role: "assistant", content: "进度<think>未完成推理" })] });
    expect(requests[0].messages[1].content).toContain("[Assistant]: 进度");
    expect(requests[0].messages[1].content).not.toContain("未完成推理");
  });

  it("文本工具协议转换为 Pi toolCall/toolResult，不把工具结果当用户目标", async () => {
    const { llm, requests } = provider();
    const result = await generatePiSummary(llm, { ...base, history: [user(),
      entry("call", { role: "assistant", content: '<think>private</think>\n' + JSON.stringify({
        type: "tool_calls", calls: [{ id: "c", name: "read_file", input: { path: "text.txt" } }]
      }) }),
      entry("result", { role: "user", content: JSON.stringify({ type: "tool_results", results: [{ id: "c", output: "text result" }] }) })
    ] });
    const prompt = requests[0].messages[1].content;
    expect(prompt).toContain('[Assistant tool calls]: read_file(path="text.txt")');
    expect(prompt).toContain('[Tool result]: {"type":"tool_results"');
    expect(prompt).not.toContain('[User]: {"type":"tool_results"');
    expect(prompt).not.toContain("private");
    expect(result.readFiles).toEqual(["text.txt"]);
  });

  it.each([2000, 12])("工具结果按 %i 字符预览并标记截断，原消息保持全文", async (limit) => {
    const { llm, requests } = provider();
    const content = "x".repeat(2005) + "TAIL";
    const history = [user(), entry("tool", { role: "tool", toolCallId: "c", content })];
    const before = structuredClone(history);
    await generatePiSummary(llm, { ...base, history, summaryToolResultMaxChars: limit });
    const prompt = requests[0].messages[1].content;
    expect(prompt).toContain("[Tool result]: " + "x".repeat(limit));
    expect(prompt).toContain(String(content.length - limit));
    expect(prompt).toContain("截断");
    expect(prompt).not.toContain("TAIL");
    expect(history).toEqual(before);
  });

  it("空原生 toolCalls 数组不遮蔽有效文本工具调用", async () => {
    const { llm, requests } = provider();
    const result = await generatePiSummary(llm, { ...base, history: [entry("call", {
      role: "assistant", toolCalls: [], content: JSON.stringify({ type: "tool_calls",
        calls: [{ id: "c", name: "read_file", input: { path: "empty-native.txt" } }] })
    })] });
    expect(requests[0].messages[1].content).toContain('[Assistant tool calls]: read_file(path="empty-native.txt")');
    expect(result.readFiles).toEqual(["empty-native.txt"]);
  });

  it("达到预览上限无需截断，不把工具返回文本误当 reasoning 清除", async () => {
    const { llm, requests } = provider();
    const text = "<think>文件字面内容</think>";
    await generatePiSummary(llm, { ...base, history: [entry("tool", { role: "tool", content: text })],
      summaryToolResultMaxChars: text.length });
    expect(requests[0].messages[1].content).toContain("[Tool result]: " + text);
    expect(requests[0].messages[1].content).not.toContain("截断");
  });

  it("摘要纯转换保持最近的原生工具 batch 全文及调用关系", async () => {
    const messages = [
      user("分析当前项目"),
      entry("old-call", { role: "assistant", content: "旧调用" }),
      entry("old-result", { role: "tool", content: "旧结果" }),
      entry("latest-call", { role: "assistant", content: "", toolCalls: [
        { id: "r1", name: "read_file", input: { path: "README.md" } },
        { id: "r2", name: "read_file", input: { path: "package.json" } }
      ] }),
      entry("r1", { role: "tool", toolCallId: "r1", content: "完整 README ".repeat(1000) }),
      entry("r2", { role: "tool", toolCallId: "r2", content: "完整 package ".repeat(1000) })
    ];
    const before = structuredClone(messages);
    const prepared = prepareConversationCompaction(messages, 1000, "scope");
    expect(prepared?.retained).toEqual(messages.slice(-3));
    const { llm, requests } = provider([{ content: "保留原始目标的前缀摘要" }]);
    await generatePiSummary(llm, { ...base, history: prepared!.history, turnPrefix: prepared!.turnPrefix });
    expect(messages).toEqual(before);
    expect(prepared?.retained).toEqual(before.slice(-3));
    expect(requests[0].messages[1].content).toContain("分析当前项目");
    expect(requests[0].messages[1].content).not.toContain("完整 README");
  });

  it("从当前 history/prefix 提取文件列表，去重排序并排除已修改文件", async () => {
    const calls = [
      { id: "1", name: "read_file", input: { path: "z.ts" } },
      { id: "2", name: "read_many_files", input: { paths: ["a.ts", "b.ts", "z.ts", ""] } },
      { id: "3", name: "write_file", input: { path: "b.ts", content: "x" } },
      { id: "4", name: "apply_patch", input: { patches: [{ path: "p.ts", oldText: "x", newText: "y" }] } },
      { id: "5", name: "edit_file", input: { path: "e.ts" } },
      { id: "6", name: "search_text", input: { path: "not-a-read.ts" } }
    ];
    const { llm } = provider();
    const result = await generatePiSummary(llm, { ...base,
      history: [user(), entry("files", { role: "assistant", content: "", toolCalls: calls })],
      turnPrefix: [entry("more", { role: "assistant", content: "",
        toolCalls: [{ id: "7", name: "read_file", input: { path: "q.ts" } }] })] });
    expect(result.readFiles).toEqual(["a.ts", "q.ts", "z.ts"]);
    expect(result.modifiedFiles).toEqual(["b.ts", "e.ts", "p.ts"]);
    expect(result.summaryMarkdown).toContain("<read-files>\na.ts\nq.ts\nz.ts\n</read-files>");
    expect(result.summaryMarkdown).toContain("<modified-files>\nb.ts\ne.ts\np.ts\n</modified-files>");
  });

  it("滚动累计历史文件记录，即使模型没有复述也直接追加完整列表", async () => {
    const { llm } = provider([{ content: "新摘要没有复述任何文件列表。" }]);
    const input = { ...base, previousSummary: "旧摘要",
      previousReadFiles: ["old-read.ts", "promoted.ts", "old-read.ts"],
      previousModifiedFiles: ["old-write.ts", "shared.ts"],
      history: [entry("files", { role: "assistant", content: "", toolCalls: [
        { id: "1", name: "read_many_files", input: { paths: ["new-read.ts", "shared.ts", "old-read.ts"] } },
        { id: "2", name: "write_file", input: { path: "promoted.ts", content: "x" } },
        { id: "3", name: "edit_file", input: { path: "shared.ts" } }
      ] })] };
    const before = structuredClone(input);
    const result = await generatePiSummary(llm, input);
    expect(result.readFiles).toEqual(["new-read.ts", "old-read.ts"]);
    expect(result.modifiedFiles).toEqual(["old-write.ts", "promoted.ts", "shared.ts"]);
    expect(result.summaryMarkdown).toBe("新摘要没有复述任何文件列表。\n\n"
      + "<read-files>\nnew-read.ts\nold-read.ts\n</read-files>\n\n"
      + "<modified-files>\nold-write.ts\npromoted.ts\nshared.ts\n</modified-files>");
    expect(input).toEqual(before);
  });

  it("仅 split 前缀生成时也继承历史 fileOps，修改优先于只读", async () => {
    const { llm } = provider([{ content: "前缀摘要" }]);
    const result = await generatePiSummary(llm, { ...base, history: [], previousSummary: "旧摘要",
      previousReadFiles: ["retained.ts", "already-written.ts"], previousModifiedFiles: ["already-written.ts"],
      turnPrefix: [entry("read", { role: "assistant", content: "", toolCalls: [
        { id: "1", name: "read_file", input: { path: "already-written.ts" } }
      ] })] });
    expect(result.readFiles).toEqual(["retained.ts"]);
    expect(result.modifiedFiles).toEqual(["already-written.ts"]);
    expect(result.summaryMarkdown.endsWith("<read-files>\nretained.ts\n</read-files>\n\n"
      + "<modified-files>\nalready-written.ts\n</modified-files>")).toBe(true);
  });

  it("响应先移除完整思考块，再接受非空 Markdown，不要求 JSON 或来源 schema", async () => {
    const { llm } = provider([{ content: "<think>内部分析</think>\n" + markdown }]);
    expect((await generatePiSummary(llm, base)).summaryMarkdown).toBe(markdown);
    const plain = provider([{ content: "非空纯文本摘要" }]);
    expect((await generatePiSummary(plain.llm, base)).summaryMarkdown).toBe("非空纯文本摘要");
  });

  it.each([
    [{ content: " \n " }, "为空"],
    [{ content: "<think>只有推理</think>" }, "为空"],
    [{ content: "partial", finishReason: "length" }, "输出上限"],
    [{ content: "failed", finishReason: "error" }, "失败"],
    [{ content: "calls", finishReason: "tool_calls" }, "工具"],
    [{ content: '{"type":"tool_calls","calls":[{"id":"c","name":"read_file","input":{}}]}' }, "工具"],
    [{ content: "calls", toolCalls: [{ id: "c", name: "read_file", input: {} }] }, "工具"]
  ] satisfies Array<[Partial<LLMResponse>, string]>)("拒绝不可用摘要 %j", async (response, error) => {
    const { llm, requests } = provider([response]);
    const input = { ...base, turnPrefix: [user()] };
    const before = structuredClone(input);
    await expect(generatePiSummary(llm, input)).rejects.toThrow(error);
    expect(requests).toHaveLength(1);
    expect(input).toEqual(before);
  });

  it("prefix 生成失败不能返回已完成历史摘要作为成功结果", async () => {
    const { llm, requests } = provider([{ content: "历史成功" }, { content: "前缀不完整", finishReason: "length" }]);
    await expect(generatePiSummary(llm, { ...base, turnPrefix: [user()] })).rejects.toThrow("输出上限");
    expect(requests).toHaveLength(2);
  });

  it("Provider 异常原样上抛，不改写输入或伪造成功", async () => {
    const error = new Error("provider disconnected");
    const { llm } = provider([error]);
    const input = structuredClone(base);
    const before = structuredClone(input);
    await expect(generatePiSummary(llm, input)).rejects.toBe(error);
    expect(input).toEqual(before);
  });

  it("开始前取消不调用 Provider", async () => {
    const { llm, requests } = provider();
    const controller = new AbortController();
    const reason = new Error("用户取消");
    controller.abort(reason);
    await expect(generatePiSummary(llm, { ...base, signal: controller.signal })).rejects.toBe(reason);
    expect(requests).toHaveLength(0);
  });

  it("Provider 返回后已取消，不接受结果，也不继续 prefix 请求", async () => {
    const controller = new AbortController();
    const reason = new Error("用户取消");
    let calls = 0;
    const llm: LLMProvider = { complete: async (request) => {
      calls++;
      expect(request.signal).toBe(controller.signal);
      controller.abort(reason);
      return { id: "response", requestId: request.id, model: request.model, content: markdown,
        finishReason: "stop", outputLength: markdown.length, durationMs: 1 };
    } };
    await expect(generatePiSummary(llm, { ...base, turnPrefix: [user()], signal: controller.signal })).rejects.toBe(reason);
    expect(calls).toBe(1);
  });
});
