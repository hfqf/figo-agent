# Task 模块测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/task/task-manager.test.ts tests/e2e/task-context-boundary.test.ts
npm run typecheck
npm run build
```

## 必须通过

1. 启动 Session 时自动创建 default task。
2. `/task new <标题>` 创建 Task 并切换 current task。
3. `/task current` 返回当前 Task。
4. `/task list` 返回 active / paused Task。
5. `/task switch <id>` 切换到 active 或 paused Task。
6. `/task pause` 将当前 Task 状态改为 paused。
7. paused Task 拒绝普通 Turn。
8. `/task resume <id>` 将 paused Task 恢复为 active。
9. `/task finish` 将当前 Task 状态改为 completed。
10. completed Task 拒绝普通 Turn。
11. `/task cancel` 将当前 Task 状态改为 cancelled。
12. cancelled Task 拒绝普通 Turn。
13. Turn 写入 `task_id`。
14. ContextPack 写入 `task_id`。
15. LLM HTTP capture 写入 `task_id`。
16. Artifact 写入 `task_id`。
17. TraceEvent 写入 `task_id`。
18. ContextBuilder 包含当前 Task 最近 Turn 历史。
19. `/task finish` 生成 `task-summary.md`。
20. Task Summary 进入 `artifacts`。

## Trace 验收

必须支持：

```text
task.created
task.switched
task.paused
task.resumed
task.finish.requested
task.completed
task.cancel.requested
task.cancelled
task.summary.created
task.command.rejected
task.history.loaded
```

## SQLite 验收

必须存在：

```text
tasks
turns.task_id
context_packs.task_id
llm_http_captures.task_id
artifacts.task_id
trace_events.task_id
```

## 人工验收

```bash
printf "/task current\n第一轮：理解当前项目\n第二轮：继续补充\n/task finish\n/exit\n" | npm run dev
```

通过标准：

1. 两个普通输入属于同一个 Task。
2. 第二轮 ContextPack 包含第一轮 Turn 摘要。
3. `.figo-agent/figo-agent.db` 中 `llm_http_captures.task_id` 有值。
4. 生成 `task-summary.md`。

## 禁止放行条件

1. 普通 Turn 没有 `task_id`。
2. ContextBuilder 仍只看当前 Turn。
3. `/task finish` 只改状态，不生成 Task Summary。
4. paused / completed / cancelled Task 仍能接收普通输入。
5. LLM 抓包不能按 Task 查询。
6. Task 和 Goal 混成一个对象。
