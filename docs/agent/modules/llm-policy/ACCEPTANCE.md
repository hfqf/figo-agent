# LLM / Policy 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- --run tests/config/runtime-config.test.ts tests/plugin/builtin-plugins.test.ts tests/kernel/agent-kernel.test.ts tests/llm/openai-compatible-provider.test.ts tests/policy/controlled-tool-policy.test.ts
npm test
npm run typecheck
npm run build
```

## 必须通过

1. 未配置当前模型的 `apiKey` 时返回本地占位响应。
2. 默认 `llm[0].baseUrl` 为 `https://api.minimaxi.com/v1`，默认 `activeModelId=minimax`、模型 `MiniMax-M3`。
3. 多个模型条目以唯一 ID 注册；`enabled=false` 的条目不注册。
4. `activeModelId` 指向已启用条目，普通 Turn、Task 压缩和轮次压缩使用同一模型；抓包记录条目 ID 与模型名。
5. 无效选中项、关闭项、重复 ID、未知协议或无效 JSON 拒绝启动，不回退到 MiniMax。
6. 旧单对象 `llm` 配置仍可读取，映射为单个启用条目。
7. `list_files`、`read_file`、`search_text` 按工具允许列表执行。
8. 写文件、命令操作按 `ControlledToolPolicy` 与允许列表受控执行。
9. 路径越界被拒绝。

## 安全验收

```bash
node -e 'const c=require("./figo-agent.config.json"); if(c.llm.some(m=>m.apiKey)) { console.error("配置文件包含非空 apiKey"); process.exit(1) }'
! git grep -l -E '(^|[^[:alnum:]_])sk-[[:alnum:]_-]{16,}' -- .
```

通过标准：无真实 API Key 命中。

## Live 测试

Live 测试只在本机 `figo-agent.config.json` 设置：

```json
{
  "activeModelId": "minimax",
  "llm": [{ "id": "minimax", "enabled": true, "provider": "openai-compatible", "apiKey": "<local secret>", "baseUrl": "https://api.minimaxi.com/v1", "model": "MiniMax-M3" }]
}
```

## 禁止放行条件

1. API Key 写入源码。
2. API Key 写入文档。
3. API Key 写入 Trace、SQLite、JSONL、Markdown Artifact。
4. Tool 执行绕过 Policy。
5. LLM 或 Tool 运行控制绕过 `figo-agent.config.json`。

## 2026-10-11 多模型配置验收记录

- `npm test`：37 个测试文件、103 项测试通过；`npm run typecheck`、`npm run build`、`git diff --check` 通过；本机 `figo-agent.config.json` 加载校验通过。
- 数组配置测试覆盖显式选择、多个已启用条目、关闭条目不注册、重复 ID、未知/关闭的选中项、未知协议及无效 JSON；选中项关闭时在创建存储前拒绝启动。
- Kernel 端到端测试确认普通 Turn 与 `/compact` 均请求选中模型，HTTP 抓包保存对应条目 ID、模型名和压缩用途。
- 本机原有单对象配置经构建后的配置加载器读取为 `version=2`、`activeModelId=minimax`、一个已启用条目，原有密钥未改写。真实 GPT 中转的聊天接口已在本次改动前通过现有 OpenAI 兼容 Provider 调用；本次端到端路由测试使用确定性 HTTP 替身，不据此宣称完成新配置格式的真实计费调用。
