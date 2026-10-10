# Context 实施计划

## 目标

实现 V1 ContextBuilder，生成 ContextPack、ContextItem，并输出 `context.md` 所需结构化事实。

## 文件

- `src/context/context-builder.ts`
- `tests/context/context-builder.test.ts`

## 实施步骤

1. 读取当前 Turn 输入。
2. 读取 `AGENTS.MD`。
3. 读取 `readme.md`。
4. 读取 Memory 命中摘要。
5. 生成 ContextItem。
6. 估算 token。
7. 按 V1 规则 included。
8. 写入 `context_packs`。
9. 写入 `context_items`。
10. 记录 `context.build.started`。
11. 记录 `context.item.included`。
12. 记录 `context.build.completed`。

## 依赖

- StorageManager。
- TraceRecorder。
- SQLiteMemoryStore。

## 不做

- 不直接调用 LLM。
- 不执行 Tool。
- 不生成最终报告。
- 不做复杂压缩。
