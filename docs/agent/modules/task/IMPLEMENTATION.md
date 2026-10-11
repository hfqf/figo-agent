# Task 模块实施计划

## 目标

实现 V1.1 Task Context Boundary，让多轮聊天归属于同一个任务，并支持任务生命周期闭环。

## 文件

- `src/task/task-manager.ts`
- `tests/task/task-manager.test.ts`
- `tests/e2e/task-context-boundary.test.ts`
- `src/storage/schema.ts`
- `src/contracts/types.ts`
- `src/kernel/agent-kernel.ts`
- `src/cli/input-router.ts`
- `src/context/context-builder.ts`
- `src/llm/llm-http-capture-store.ts`
- `src/trace/trace-recorder.ts`
- `src/reporter/markdown-reporter.ts`

## 实施步骤

1. 扩展 contracts，增加 `Task`、`TaskStatus`、`TaskSummary`。
2. 扩展 SQLite schema，增加 `tasks` 表。
3. 给 `turns`、`context_packs`、`llm_http_captures`、`artifacts`、`trace_events` 增加 `task_id`。
4. 实现 `TaskManager.createDefault(sessionId)`。
5. 实现 `TaskManager.create(title)`。
6. 实现 `TaskManager.current(sessionId)`。
7. 实现 `TaskManager.list(sessionId)`。
8. 实现 `TaskManager.switch(taskId)`。
9. 实现 `TaskManager.pause(taskId)`。
10. 实现 `TaskManager.resume(taskId)`。
11. 实现 `TaskManager.finish(taskId)`。
12. 实现 `TaskManager.cancel(taskId, reason)`。
13. 扩展 `MarkdownReporter.writeTaskSummary()`，生成 `task-summary.md`。
14. InputRouter 增加 `/task` 命令解析。
15. AgentKernel 启动时创建 default task。
16. AgentKernel 普通 Turn 绑定 current task。
17. AgentKernel 拒绝非 active Task 的普通输入。
18. ContextBuilder 读取 Task 历史 Turn、LLM capture 摘要、Artifact 摘要。
19. LLMHttpCaptureStore 写入 `task_id`。
20. TraceRecorder 支持 `task_id`。
21. Reporter 写 Artifact 时写入 `task_id`。
22. 补齐 Task 生命周期 Trace。

## 关键流程

```text
CLI 普通输入
  -> AgentKernel 读取 current task
  -> 校验 task.status == active
  -> 创建 Turn 并写入 task_id
  -> AgentLoop 构造 ContextPack
  -> ContextBuilder 加载 Task 历史
  -> LLMProvider 调用模型
  -> LLMHttpCaptureStore 写入 task_id
  -> Reporter 写 context.md / report.md
```

```text
/task finish
  -> TaskManager.finish
  -> 聚合 Task 历史
  -> MarkdownReporter.writeTaskSummary
  -> tasks.status = completed
  -> trace task.summary.created
  -> trace task.completed
```

## 不做

1. 不实现 Goal。
2. 不实现 Verifier。
3. 不实现 Task UI。
4. 不实现多 Task 并发执行。
5. 不实现 Task 自动拆分。
