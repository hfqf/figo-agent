# Storage 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/storage/storage-manager.test.ts
npm test -- tests/utils-smoke.test.ts
npm run typecheck
```

## 必须通过

1. 初始化后存在 `.figo-agent/`。
2. 初始化后存在 `.figo-agent/figo-agent.db`。
3. SQLite 包含 V1 所有表。
4. SQLite 包含 V1 索引。
5. 新连接的 `busy_timeout` 默认 5000 毫秒；设置 `storage.sqliteBusyTimeoutMs` 后按配置生效，短暂写锁不会立即失败。
6. Artifact 文件成功写入。
7. Artifact 元数据写入 `artifacts`。
8. 非法路径被拒绝。
9. Markdown 正文不写入 SQLite 主状态。
10. 新写入的时间列为上海时间 `YYYY-MM-DD HH:mm:ss.SSS`，精确到毫秒。
11. 旧 UTC 或带 `+08:00` 的时间列在初始化时转换一次，重复初始化不重复偏移。
12. 无时区的旧时间会使迁移整体回滚，不按运行机器的时区猜测。

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
5. SQLite 时间列仍含 `T`、`Z`、`+08:00`，或缺少毫秒。
6. 迁移失败后留下部分已转换的行，或错误推进 `user_version`。
