# LLM / Policy 实施计划

## 目标

实现 MiniMax OpenAI-compatible LLMProvider 和 ControlledToolPolicy，确保模型调用、运行配置和权限决策分离。

## 文件

- `src/llm/openai-compatible-provider.ts`
- `src/policy/read-only-policy.ts`
- `tests/llm/openai-compatible-provider.test.ts`
- `tests/policy/read-only-policy.test.ts`

## 实施步骤

1. 实现 `loadRuntimeConfig()`，读取 `figo-agent.config.json`。
2. 从选中 `llm` 条目的 `apiKey`、`baseUrl`、`model` 装配 OpenAICompatibleProvider。
3. 默认 base URL 使用 `https://api.minimaxi.com/v1`。
4. 默认模型使用 `MiniMax-M3`。
5. 未配置当前模型条目的 `apiKey` 时返回本地占位响应。
6. 实现 ControlledToolPolicy。
7. 从 `tools.allowed` 生成允许动作集合。
8. 拒绝未配置开放的 Tool、工作区越界、危险命令和非 http/https URL。
9. Policy 判断写入 `policy.evaluated`。
10. Policy 拒绝写入 `policy.denied`。

## 依赖

- LLMProvider contract。
- Policy contract。
- TraceRecorder。

## 不做

- 不把 API Key 写入源码、文档、Trace、SQLite、JSONL、Markdown Artifact 和测试快照。
- 不做流式输出。
- 不做多模型路由。
- 不做用户二次确认。
