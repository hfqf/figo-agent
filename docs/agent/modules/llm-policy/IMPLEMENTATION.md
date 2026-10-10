# LLM / Policy 实施计划

## 目标

实现 MiniMax OpenAI-compatible LLMProvider 和 V1 ReadOnlyPolicy，确保模型调用和权限决策分离。

## 文件

- `src/llm/openai-compatible-provider.ts`
- `src/policy/read-only-policy.ts`
- `tests/llm/openai-compatible-provider.test.ts`
- `tests/policy/read-only-policy.test.ts`

## 实施步骤

1. 实现 `OpenAICompatibleProvider.fromEnv()`。
2. 从环境变量读取 `MINIMAX_API_KEY`、`MINIMAX_BASE_URL`、`MINIMAX_MODEL`。
3. 默认 base URL 使用 `https://api.minimaxi.com/v1`。
4. 默认模型使用 `MiniMax-M2.7`。
5. 未配置 API Key 时返回本地占位响应。
6. 实现 ReadOnlyPolicy。
7. 只允许 `tool.list_files`、`tool.read_file`、`tool.search_text`。
8. 拒绝写文件、命令、Git、网络、浏览器。
9. Policy 判断写入 `policy.evaluated`。
10. Policy 拒绝写入 `policy.denied`。

## 依赖

- LLMProvider contract。
- Policy contract。
- TraceRecorder。

## 不做

- 不把 API Key 写入任何文件。
- 不做流式输出。
- 不做多模型路由。
- 不做用户二次确认。
