# Memory 实施计划

## 目标

实现 V1 Memory 读取路径，支持从 SQLite 查询稳定记忆并进入 Context 摘要。

## 文件

- `src/memory/sqlite-memory-store.ts`
- `tests/memory/sqlite-memory-store.test.ts`

## 实施步骤

1. 定义 MemoryRecord。
2. 实现 `SQLiteMemoryStore.search(scope)`。
3. 支持 `project`、`user`、`agent`、`knowledge` scope。
4. 查询结果按 updatedAt 倒序。
5. 记录 `memory.search.started`。
6. 记录 `memory.search.completed`。
7. 查询失败返回空数组并记录错误。

## 依赖

- StorageManager。
- TraceRecorder。

## 不做

- 不自动写入 Memory。
- 不做向量检索。
- 不做 Memory 去重。
- 不做 Memory 过期。
