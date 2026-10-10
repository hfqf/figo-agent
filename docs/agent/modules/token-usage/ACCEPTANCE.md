# TokenUsage 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/context/context-builder.test.ts tests/llm/openai-compatible-provider.test.ts tests/reporter/markdown-reporter.test.ts
npm run typecheck
```

## 必须通过

1. ContextItem 写入 estimatedTokens。
2. ContextPack 写入 estimatedTokens。
3. LLMRequest 包含 estimatedInputTokens。
4. LLMResponse 包含 outputLength。
5. `llm.called` 包含 estimatedInputTokens。
6. `llm.completed` 包含 outputLength。
7. `report.md` 展示 token 估算摘要。

## 数据库验收

V1 不存在 `token_usage` 表。

## 禁止放行条件

1. V1 引入精确 TokenUsage 入库。
2. V1 将估算 token 和实际 token 混写到同一字段。
3. V1 因 token 统计阻断主流程。
