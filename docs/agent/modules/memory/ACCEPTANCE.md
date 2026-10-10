# Memory 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/memory/sqlite-memory-store.test.ts
npm run typecheck
```

## 必须通过

1. 能从 `memory_records` 查询 project memory。
2. 能从 `memory_records` 查询 user memory。
3. 查询结果按 updatedAt 倒序。
4. 无记录时返回空数组。
5. Memory 查询不会创建新 Memory。

## Trace 验收

必须支持：

```text
memory.search.started
memory.search.completed
```

## 禁止放行条件

1. V1 自动写 Memory。
2. Memory 查询失败导致 AgentLoop 崩溃。
3. Markdown memory 文件成为唯一状态源。
4. Memory 直接调用 LLM。
