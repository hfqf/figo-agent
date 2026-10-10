# AgentLoop 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/e2e/project-understanding.test.ts
npm run typecheck
```

## 必须通过

1. 每个 Turn 只构造一次 ContextPack。
2. 每个 Turn 只调用一次 LLMProvider。
3. 每个 Turn 最多激活一个 Skill。
4. Tool 调用必须经过 ToolRegistry。
5. ToolRegistry 必须经过 Policy。
6. 成功时生成 TurnResult。
7. 成功时生成 `context.md`。
8. 成功时生成 `report.md`。
9. 失败时写入 `turn.failed`。

## Trace 验收

`trace.jsonl` 至少包含：

```text
turn.processing
context.build.completed
llm.called
llm.completed
skill.completed
artifact.created
turn.completed
```

## 禁止放行条件

1. AgentLoop 直接读取文件。
2. AgentLoop 绕过 PluginHost 获取能力。
3. AgentLoop 绕过 Reporter 写 Markdown。
4. AgentLoop 在 V1 中调用 `apply_patch` 或 `run_command`。
