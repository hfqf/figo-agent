# Task 上下文压缩测试验收

## 放行规则

任务 1 至任务 5 按顺序验收。当前任务未通过，不进入下一任务；所有自动化与人工证据均通过，才允许宣布上下文压缩可用。文档本身不是测试通过的证据。

## 自动化命令

```bash
npm test -- --run tests/storage/compaction-store.test.ts tests/kernel/turn-manager.test.ts
npm test -- --run tests/context/task-history-reader.test.ts tests/context/compaction-summary.test.ts tests/context/compaction-service.test.ts tests/context/round-compaction.test.ts
npm test -- --run tests/context/compaction-policy.test.ts tests/context/context-builder.test.ts tests/config/runtime-config.test.ts
npm test -- --run tests/cli/input-router.test.ts tests/kernel/agent-kernel.test.ts tests/loop/agent-loop-tool-calling.test.ts tests/e2e/task-context-compaction.test.ts tests/llm/llm-http-capture-store.test.ts
npm test
npm run typecheck
npm run build
```

## 必须覆盖的场景

1. 旧 SQLite 数据升级后，每个 Task 的 Turn 顺序号稳定；重启不改变既有顺序，后续 Turn 递增。
2. 压缩阈值前，超过旧的 5 Turn 上限的历史仍全部进入 ContextPack；不出现静默历史丢失。
3. 手动 `/compact` 不生成普通 Turn；无候选返回无需压缩，不调用 LLM；有候选时只压缩已终结的连续前缀。
4. 自动触发只由 agent 的字符量或 Turn 数策略决定；同一策略在 MiniMax 与替换后的测试 Provider 上行为一致。
5. 成功后 ContextPack 包含最新检查点、未覆盖原始 Turn、当前输入，且每个条目可追溯来源；同一原始 Turn 不重复进入摘要和原始尾部。
6. 滚动压缩使用上一个检查点摘要与新覆盖 Turn；旧检查点仍可查，最新检查点的覆盖边界单调递增。
7. 原始 `turns`、`llm_http_captures` 与工具结果不删除、不覆写；摘要生成抓包标记用途，不能成为普通历史助手答复。
8. LLM HTTP 错误、占位响应、无效 JSON、字段缺失、错误来源 ID、摘要超长及事务冲突都不能生成检查点；自动路径回退原始历史，手动路径返回明确失败。
9. 重开 SQLite 后按同一 Task ID 能读取最新检查点；切换到另一个 Task 不读入前一 Task 的摘要。CLI 重启后续接旧 Task 不在本次范围。
10. 工具循环每次调用前检查增长；压缩旧往返后仍保留最新 ToolResult 原文；轮次摘要不改变 Task 检查点。
11. 配置缺失/无效时回退代码默认值；`autoEnabled=false` 只关闭自动触发，手动命令仍可使用。

## Trace 与 SQLite 人工复核

一次成功压缩至少能串起 `compaction.requested`、`compaction.started`、`compaction.completed`、`task_compaction_checkpoints.id`、`request_id`、`llm_http_captures.purpose` 和下一次 `context_items.source_ref`。跳过或失败有对应 Trace，不出现「记录成功但检查点不存在」。

人工抽查至少两组连续对话：一组包含真实工具结果和追问，一组在同一 Session 内切换 Task 后继续原 Task。另行重开 SQLite 验证检查点持久化。逐项核对原始 Turn、摘要中的目标/事实/决定/未决事项、最终 ContextPack 和实际 HTTP 抓包。若关键事实仅在原始记录中而未进入摘要或尾部原文，验收失败，先修复摘要输入/校验/策略再放行。

## 禁止放行条件

1. 超过历史窗口后没有摘要，且旧 Turn 从 ContextPack 消失。
2. 模型返回占位文案或无效摘要仍被写成检查点。
3. 压缩请求混入普通 Turn 最终回答，或不同 Task/Session 交叉污染。
4. 压缩失败导致原始历史、工具结果或 HTTP 抓包被删除。
5. 只跑单元测试，未完成 Task 切换、工具循环和 SQLite/Trace 闭环检查。
6. 任一必需测试、类型检查或构建失败。

长 ID 回归验收：压缩请求中的 Turn 引用必须是本次请求的短引用；旧检查点在滚动请求中也必须转换；模型返回未知短引用时不得写检查点；成功后检查点和 ContextPack 必须使用真实 Turn ID。

## 2026-10-11 验收记录

- 自动化：全量 Vitest 36 个测试文件、94 项测试通过；`npm run typecheck`、`npm run build`、`git diff --check` 通过。存储迁移、滚动检查点、失败回退、轮次摘要和 Task 切换均有定向测试。
- 真实提供方冒烟：使用本地配置向 MiniMax 发起压缩请求，HTTP 200；返回 `completed`，SQLite 中存在检查点，抓包用途为 `task_compaction`。测试数据位于隔离临时目录，未写入项目 Session。
- 人工 SQLite/Trace 抽查：隔离工作区中执行真实 `system_info` 工具、下一轮追问、`/compact`、新 Task 输入、切回原 Task。检查点摘要引用首轮 Turn；HTTP 抓包 `purpose=task_compaction`、`response_status=200`；`compaction.requested`、`started`、`completed` 的请求 ID 与检查点 ID 可串联；返回原 Task 的 ContextPack 含 `task.compaction:<id>` 和未覆盖的 `task.turn:<id>`，不含另一 Task 的 Turn。此抽查的 LLM HTTP 响应为确定性替身，工具本身执行了真实的内置实现。
- 重开 SQLite、旧检查点滚动、命令幂等和失败不覆盖历史由 `compaction-store`、`compaction-service` 与端到端测试验证。摘要语义质量仍须在真实长任务中持续抽样；本次放行只证明来源、持久化和运行链路正确，不以测试替身证明模型摘要质量。

## 2026-10-11 长 ID 回归记录

- 修复前实测：当前配置的 `gpt-relay / gpt-5.6-sol` 返回 HTTP 200，但把一个长 Turn ID 抄错一位；`compaction.failed` 记录来源校验失败，没有写入检查点，Turn 使用原始历史继续完成。
- 修复后实测：隔离工作区中预置 12 条带 UUID 的已完成 Turn，共 1398 字符；第 13 个 Turn 在 `turn threshold reached` 后触发自动压缩。抓包显示模型请求只包含 `t1` 至 `t7`，响应 HTTP 200；检查点覆盖第 1 至第 7 条，摘要和检查点均保存原始 UUID；ContextPack 包含该检查点及第 8 至第 12 条原文，Turn 正常完成。
- 自动化：`compaction-service.test.ts` 覆盖短引用映射、滚动检查点和未知短引用拒绝；全量 Vitest 37 个文件、109 项测试通过，类型检查与构建通过。
