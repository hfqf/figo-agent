# LLM / Policy 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/config/runtime-config.test.ts tests/llm/openai-compatible-provider.test.ts tests/policy/controlled-tool-policy.test.ts
npm run typecheck
```

## 必须通过

1. 未配置 `llm.apiKey` 时返回本地占位响应。
2. 默认 `llm.baseUrl` 为 `https://api.minimaxi.com/v1`。
3. 默认 `llm.model` 为 `MiniMax-M3`。
4. `list_files` 被允许。
5. `read_file` 被允许。
6. `search_text` 被允许。
7. 写文件动作被拒绝。
8. 命令动作被拒绝。
9. 路径越界被拒绝。

## 安全验收

```bash
rg -n "sk-[A-Za-z0-9_\\-]{16,}" . --glob '!node_modules/**' --glob '!dist/**' --glob '!figo-agent.config.json'
```

通过标准：无真实 API Key 命中。

## Live 测试

Live 测试只在本机 `figo-agent.config.json` 设置：

```json
{
  "llm": {
    "apiKey": "<local secret>",
    "baseUrl": "https://api.minimaxi.com/v1",
    "model": "MiniMax-M3"
  }
}
```

## 禁止放行条件

1. API Key 写入源码。
2. API Key 写入文档。
3. API Key 写入 Trace、SQLite、JSONL、Markdown Artifact。
4. Tool 执行绕过 Policy。
5. LLM 或 Tool 运行控制绕过 `figo-agent.config.json`。
