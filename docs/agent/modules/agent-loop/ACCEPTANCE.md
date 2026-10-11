# AgentLoop 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/e2e/project-understanding.test.ts
npm test -- --run tests/loop/tool-call-parser.test.ts tests/loop/llm-message-builder.test.ts tests/loop/tool-calling-runtime.test.ts tests/loop/agent-loop-tool-calling.test.ts
npm run typecheck
npm run build
```

## 必须通过

1. 每个 Turn 只构造一次 ContextPack。
2. 无 ToolCall 时，AgentLoop 只调用一次 LLMProvider。
3. 有合法 ToolCall 时，AgentLoop 执行 LLM -> Tool -> LLM 有界循环。
4. Tool Calling Loop 默认最大轮次为 `3`。
5. LLM 请求必须包含 `ContextItem.content`，不能只发送 `summary`。
6. Tool 调用必须经过 ToolRegistry。
7. ToolRegistry 必须经过 Policy。
8. 成功时生成 TurnResult。
9. 成功时生成 `context.md`。
10. 成功时生成 `report.md`。
11. 失败时写入 `turn.failed`。
12. 非法 `<function_calls>` 不触发 Tool 执行。
13. MiniMax 内联 `tool_calls` JSON 触发工具执行，ToolResult 进入下一次 LLM 请求。
14. 普通最终答复记录 `tool_call.parse.completed` 且 `callCount = 0`；畸形内联 JSON 记录解析失败。

## Trace 验收

`trace.jsonl` 至少包含：

```text
turn.processing
context.build.completed
llm.called
llm.completed
skill.completed
tool_call.parse.started
tool_call.parse.completed
tool_call.round.started
tool_call.round.completed
tool_call.result.appended
artifact.created
turn.completed
```

## 禁止放行条件

1. AgentLoop 直接读取文件。
2. AgentLoop 绕过 PluginHost 获取能力。
3. AgentLoop 绕过 Reporter 写 Markdown。
4. AgentLoop 直接执行 Tool。
5. AgentLoop 执行 `<function_calls>`。
6. AgentLoop 从自然语言中抽取 shell 命令执行。
7. Tool Calling Loop 没有最大轮次限制。
