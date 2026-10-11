# Storage 实施计划

## 目标

实现 `.figo-agent/`、SQLite schema、JSONL 和 Markdown Artifact 的本地持久化能力。

## 文件

- `src/storage/schema.ts`
- `src/storage/storage-manager.ts`
- `src/utils/path.ts`
- `tests/storage/storage-manager.test.ts`

## 实施步骤

1. 创建 `.figo-agent/`。
2. 创建 `.figo-agent/figo-agent.db`。
3. 创建 `.figo-agent/artifacts/sessions/`。
4. 创建 `.figo-agent/memory/`。
5. 创建 V1 SQLite schema。
6. 创建 V1 索引。
7. 实现 `StorageManager.init(workspaceRoot)`。
8. 实现 `getSessionDir(sessionId)`。
9. 实现 `writeArtifact(input)`。
10. Artifact 写入采用临时文件替换。
11. Artifact 元数据写入 `artifacts`。

## 依赖

- Node 文件系统。
- Node 22 built-in SQLite。

## 不做

- 不做 migration 框架。
- 不做备份恢复。
- 不做远程存储。
- 不保存 Markdown 全文到 SQLite。
