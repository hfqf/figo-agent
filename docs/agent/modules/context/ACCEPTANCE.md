# Context 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/context/context-builder.test.ts
npm test -- --run tests/context/context-builder.test.ts tests/loop/agent-loop-tool-calling.test.ts tests/e2e/task-context-boundary.test.ts
npm run typecheck
```

## 必须通过

1. ContextPack 包含当前 Turn 输入。
2. 默认配置下 ContextPack 不包含 `AGENTS.MD`。
3. 默认配置下 ContextPack 不包含 `readme.md`。
4. ContextPack 写入 `context_packs`。
5. ContextItem 写入 `context_items`。
6. 每个 ContextItem 有 source、summary、reason、estimatedTokens。
7. estimatedTokens 大于 0。
8. Task 历史项包含历史用户输入。
9. Task 历史项包含上一轮 ToolResult。
10. Task 历史项包含上一轮最终助手回答。
11. 不读取 Agent 源工程的 `AGENTS.MD`/README 作为最终用户工作区的默认上下文；用户自定义指令按配置进入实际模型请求，具体消息以抓包为准。

## Trace 验收

必须支持：

```text
context.build.started
context.item.included
context.build.completed
```

## 禁止放行条件

1. ContextBuilder 直接调用 LLM。
2. ContextBuilder 执行 Tool。
3. ContextBuilder 写最终报告。
4. ContextPack 无来源和取舍原因。
5. Task 历史只保留用户输入，丢失 ToolResult。
6. 开发文档绕过 `code/figo-agent.config.json` 默认进入模型上下文。
