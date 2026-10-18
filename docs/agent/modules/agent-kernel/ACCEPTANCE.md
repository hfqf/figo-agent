# AgentKernel 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/kernel/agent-kernel.test.ts
npm run typecheck
```

## 必须通过

1. `AgentKernel.start` 创建 `.figo-agent/figo-agent.db`。
2. `AgentKernel.start` 创建 Session 并写入 `sessions`。
3. 启动后写入 `session.started`。
4. `submitTurn("理解当前项目")` 创建 Turn。
5. Turn 写入 `turns`。
6. 普通 Turn 调用 AgentLoop。
7. AgentLoop 成功后 Turn 状态为 `completed`。
8. AgentLoop 失败后 Turn 状态为 `failed`。
9. `/exit` 结束 Session。
10. `--version` / `-v` 输出产品版本后退出，不加载内核、创建 Session、SQLite 或调用模型。
11. 工作台显示的产品版本来自程序自身 package.json，不受用户项目 package.json 影响；App 与安装包元数据一致。专项验收见[版本号统一管理与验收](./2026-10-18-版本号统一管理与验收.md)。

## 人工验收

```bash
printf "理解当前项目\n/exit\n" | npm run dev
```

通过标准：

1. Session 和 Turn 进入 SQLite。
2. `trace.jsonl` 包含 `session.started`、`turn.received`、`turn.completed`。
3. 失败时返回中文错误摘要。

## 禁止放行条件

1. 启动失败后仍进入 REPL。
2. AgentKernel 直接 new 具体 Tool。
3. AgentKernel 绕过 TraceRecorder 写 Trace。
4. AgentKernel 绕过 Storage 拼接产物路径。
