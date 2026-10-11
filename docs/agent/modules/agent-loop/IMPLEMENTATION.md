# AgentLoop 实施计划

## 目标

实现单轮受控 AgentLoop，把 Turn 编排为 Context、LLM、Skill、Tool、Reporter 和 Trace 的完整闭环。

## 文件

- `src/loop/agent-loop.ts`
- `tests/e2e/project-understanding.test.ts`

## 实施步骤

1. 接收 Session 和 Turn。
2. 记录 `turn.processing`。
3. 调用 ContextBuilder 构造 ContextPack。
4. 调用 LLMProvider 获取 LLMResponse。
5. 激活 `project-understanding-skill`。
6. 通过 ToolRegistry 执行只读 Tool。
7. 调用 MarkdownReporter 生成 `context.md` 和 `report.md`。
8. 返回 TurnResult。
9. 成功记录 `turn.completed`。
10. 失败记录 `turn.failed` 和 `error.occurred`。

## V1.2 Tool Calling Loop 实施状态

已实现：

1. `ToolCallParser`：解析 fenced JSON 和 MiniMax 内联 JSON ToolIntent，拒绝 `<function_calls>`。
2. `LLMMessageBuilder`：初始 LLM 请求包含 `ContextItem.content`。
3. `ToolCallingRuntime`：按批次执行 ToolIntent，并保留 `callId`。
4. `AgentLoop`：支持有界 LLM -> Tool -> LLM 循环，默认最大轮次为 `3`。
5. Trace：记录 `tool_call.parse.*`、`tool_call.round.*`、`tool_call.result.appended`。
6. 回归测试：覆盖本机配置查询、内联 JSON 触发 LLM -> Tool -> LLM、历史上下文内容进入 LLM 请求、XML 假工具调用不执行。
7. 普通最终答复记录 `tool_call.parse.completed`，其中 `callCount = 0`。

验收命令：

```bash
npm test -- --run tests/loop/tool-call-parser.test.ts tests/loop/llm-message-builder.test.ts tests/loop/tool-calling-runtime.test.ts tests/loop/agent-loop-tool-calling.test.ts
npm test
npm run typecheck
npm run build
```

## 依赖

- ContextBuilder。
- LLMProvider。
- SkillRunner 或内置 Skill。
- ToolRegistry。
- MarkdownReporter。
- TraceRecorder。

## 不做

- 不做无限循环。
- 不做 Goal。
- 不做多 Skill 编排。
- 不自动追加 Turn。
