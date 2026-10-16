# Context 实施计划

> 当前增量见 [Pi 实施计划](./2026-10-15-Pi上下文压缩对齐实施计划.md) 和 [验收记录](./2026-10-15-Pi上下文压缩对齐测试验收.md)。代码已接入，真实三模型放行尚未完成。

## 目标

实现 V1 ContextBuilder，生成 ContextPack、ContextItem，并输出 `context.md` 所需结构化事实。ContextBuilder 的运行行为由 `code/figo-agent.config.json` 的 `context` 段控制。

## 文件

- `src/context/context-builder.ts`
- `tests/context/context-builder.test.ts`

## 实施步骤

1. 读取当前 Turn 输入。
2. 按当前 Task 消息级边界读取历史；没有摘要时保留全部可重建历史，不按固定 Turn 数静默丢弃。
3. 只读取当前 Turn、Task 历史、用户显式文件引用及 Memory；不从源工程配置注入默认项目文档。
4. 按 `context.includeMemory` 决定是否读取 Memory 命中摘要。
5. 生成 ContextItem。
6. 估算 token。
7. 按 V1 规则 included。
8. 写入 `context_packs`。
9. 写入 `context_items`。
10. 记录 `context.build.started`。
11. 记录 `context.item.included`。
12. 记录 `context.build.completed`。

## V1.2 Task 历史增强

已实现：

1. `task_turn` 历史项不再只保存历史用户输入。
2. ContextBuilder 从 `llm_http_captures` 中提取历史 Turn 的 `tool_results`。
3. ContextBuilder 从 `llm_http_captures` 中提取历史 Turn 的最终助手回答。
4. 历史 Turn 内容按“用户输入 / 工具结果 / 助手回答”格式进入 ContextPack。

解决的问题：

1. turn2 已经通过 `system_info` 拿到电脑信息。
2. turn3 追问实施方案时，需要看到 turn2 的系统信息和最终判断。
3. 只保存历史用户输入会导致模型不知道上一轮已经完成的观察结果。

验收命令：

```bash
npm test -- --run tests/context/context-builder.test.ts
npm test -- --run tests/loop/agent-loop-tool-calling.test.ts tests/e2e/task-context-boundary.test.ts
npm run typecheck
```

## 依赖

- StorageManager。
- TraceRecorder。
- SQLiteMemoryStore。

## 不做

- 不直接调用 LLM。
- 不执行 Tool。
- 不生成最终报告。
- ContextBuilder 不调用摘要模型；压缩准备、摘要、存储与调度由 Pi 纯函数、Service、Store 和 AgentLoop 分担。
- 不把开发文档作为默认运行控制来源。
