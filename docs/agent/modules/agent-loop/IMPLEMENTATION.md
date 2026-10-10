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
