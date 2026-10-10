# CLI / REPL 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/cli/input-router.test.ts
npm run typecheck
npm run build
```

## 必须通过

1. `routeInput("")` 返回 `empty`。
2. `routeInput("理解当前项目")` 返回 `turn`。
3. `routeInput("/report")` 返回 `command: report`。
4. 未知命令返回 `command: unknown`。
5. 普通文本调用 `AgentKernel.submitTurn`。
6. `/exit` 调用 `AgentKernel.shutdown`。
7. `/context`、`/memory`、`/report`、`/help` 不创建 Turn。
8. CLI 输出中文摘要和 Artifact 相对路径。

## 人工验收

```bash
printf "/help\n/exit\n" | npm run dev
```

通过标准：

1. 终端展示中文帮助。
2. 进程正常退出。
3. 不生成普通 Turn。

## 禁止放行条件

1. CLI 直接访问 SQLite。
2. CLI 直接调用 AgentLoop。
3. CLI 直接调用 Tool 或 Reporter。
4. 终端输出 API Key、token、secret。
