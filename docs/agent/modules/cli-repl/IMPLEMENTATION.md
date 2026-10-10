# CLI / REPL 实施计划

## 目标

实现 `figo-agent` 命令行入口，让用户通过 REPL 输入普通文本和控制命令。

## 文件

- `src/cli/main.ts`
- `src/cli/input-router.ts`
- `src/cli/renderer.ts`
- `tests/cli/input-router.test.ts`

## 实施步骤

1. 创建 `InputRoute` 类型，区分 `empty`、`command`、`turn`。
2. 实现 `routeInput(input)`：空输入忽略，`/` 开头进入命令，其余进入 Turn。
3. 实现 `renderTurnResult(result)`：中文展示执行摘要和 Artifact 路径。
4. 实现 `main.ts`：启动 AgentKernel，进入 REPL，普通文本调用 `submitTurn`，命令调用 `handleCommand`。
5. 支持 `/exit`、`/context`、`/memory`、`/report`、`/help`。
6. Ctrl-C 和 EOF 调用 `AgentKernel.shutdown()`。

## 依赖

- AgentKernel 提供 `start`、`submitTurn`、`handleCommand`、`shutdown`。
- TurnResult 和 CommandResult 来自 contracts。

## 不做

- 不访问 Storage。
- 不访问 PluginHost。
- 不直接调用 AgentLoop。
- 不直接调用 Reporter。
- 不打印完整 Markdown 报告。
