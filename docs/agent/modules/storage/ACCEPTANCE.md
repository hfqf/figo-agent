# Storage 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/storage/storage-manager.test.ts
npm run typecheck
```

## 必须通过

1. 初始化后存在 `.figo-agent/`。
2. 初始化后存在 `.figo-agent/figo-agent.db`。
3. SQLite 包含 V1 所有表。
4. SQLite 包含 V1 索引。
5. Artifact 文件成功写入。
6. Artifact 元数据写入 `artifacts`。
7. 非法路径被拒绝。
8. Markdown 正文不写入 SQLite 主状态。

## 数据库验收

必须存在表：

```text
sessions
turns
context_packs
context_items
memory_records
skill_runs
tool_calls
trace_events
artifacts
```

## 禁止放行条件

1. Artifact 写到 `.figo-agent/` 之外。
2. SQLite 初始化失败仍继续启动。
3. Markdown 正文作为唯一状态源。
4. JSONL 被当作业务查询入口。
