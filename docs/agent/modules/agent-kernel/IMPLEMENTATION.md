# AgentKernel 实施计划

## 目标

实现 V1 小内核启动装配，管理 Session / Turn 生命周期，并把普通 Turn 交给 AgentLoop。

## 文件

- `src/kernel/agent-kernel.ts`
- `src/kernel/session-manager.ts`
- `src/kernel/turn-manager.ts`
- `tests/kernel/agent-kernel.test.ts`

## 实施步骤

1. 实现 SessionManager：创建、结束、失败 Session，并写入 `sessions`。
2. 实现 TurnManager：创建、处理中、完成、失败 Turn，并写入 `turns`。
3. 实现 AgentKernel.start：按顺序初始化 Storage、TraceRecorder、PluginHost、AgentLoop、Session。
4. 实现 AgentKernel.submitTurn：创建 Turn，记录 `turn.received`，调用 AgentLoop，落盘完成或失败状态。
5. 实现 AgentKernel.handleCommand：处理 `/context`、`/memory`、`/report`、`/help`。
6. 实现 AgentKernel.shutdown：结束 Session，记录 `session.ended`。

## 依赖

- StorageManager。
- TraceRecorder。
- PluginHost。
- AgentLoop。
- MarkdownReporter。

## 不做

- 不引入 Goal。
- 不管理多 Session。
- 不执行 Tool。
- 不生成 Markdown 正文。
