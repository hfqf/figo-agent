# Context 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/context/context-builder.test.ts
npm run typecheck
```

## 必须通过

1. ContextPack 包含当前 Turn 输入。
2. ContextPack 包含 `AGENTS.MD`。
3. ContextPack 包含 `readme.md`。
4. ContextPack 写入 `context_packs`。
5. ContextItem 写入 `context_items`。
6. 每个 ContextItem 有 source、summary、reason、estimatedTokens。
7. estimatedTokens 大于 0。

## Trace 验收

必须支持：

```text
context.build.started
context.item.included
context.build.completed
```

## 禁止放行条件

1. ContextBuilder 直接调用 LLM。
2. ContextBuilder 执行 Tool。
3. ContextBuilder 写最终报告。
4. ContextPack 无来源和取舍原因。
