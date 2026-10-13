# Task 与 Agent 执行流程变更记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 Task 与 Agent 执行 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-lifecycle、03-run、04-cli | `code/src/task/task-manager.ts`、`code/src/ui/run-coordinator.ts`、`code/src/loop/agent-loop.ts`、`code/src/ui/local-api.ts`、`code/src/cli/input-router.ts` | Mermaid 浏览器渲染、点击与源图同步检查 |
