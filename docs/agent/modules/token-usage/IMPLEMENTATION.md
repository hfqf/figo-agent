# TokenUsage 实施计划

## 目标

V1 只保留 token 估算字段和 Trace 摘要；精确 TokenUsage 统计进入 V2。

## 文件

- `src/contracts/types.ts`
- `src/context/context-builder.ts`
- `src/llm/openai-compatible-provider.ts`
- `tests/context/context-builder.test.ts`
- `tests/llm/openai-compatible-provider.test.ts`

## 实施步骤

1. ContextItem 保留 `estimatedTokens`。
2. ContextPack 保留 `estimatedTokens`。
3. LLMRequest 保留 `estimatedInputTokens`。
4. LLMResponse 保留 `outputLength`。
5. `llm.called` payload 记录 `estimatedInputTokens`。
6. `llm.completed` payload 记录 `outputLength`。
7. Reporter 展示 token 估算摘要。

## 依赖

- ContextBuilder。
- LLMProvider。
- TraceRecorder。
- Reporter。

## 不做

- V1 不创建 `token_usage` 表。
- V1 不做精确 token 统计。
- V1 不做按模型计费统计。
- V1 不做 Session 级 token 汇总。
