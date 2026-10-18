# AgentLoop 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/e2e/project-understanding.test.ts
npm test -- --run tests/loop/tool-call-parser.test.ts tests/loop/llm-message-builder.test.ts tests/loop/tool-calling-runtime.test.ts tests/loop/agent-loop-tool-calling.test.ts
npm run typecheck
npm run build
```

## 必须通过

1. 每个 Turn 只构造一次 ContextPack。
2. 无 ToolCall 时，AgentLoop 只调用一次 LLMProvider。
3. 有合法 ToolCall 时，AgentLoop 持续执行 LLM -> Tool -> LLM，直到产生最终答复。
4. 连续 5 轮工具调用后仍可继续并返回最终答复，不产生轮次上限文案。
5. LLM 请求必须包含 `ContextItem.content`，不能只发送 `summary`。
6. Tool 调用必须经过 ToolRegistry。
7. ToolRegistry 必须经过 Policy。
8. 成功时生成 TurnResult。
9. 成功时生成 `context.md`。
10. 成功时生成 `report.md`。
11. 失败时写入 `turn.failed`。
12. 非法 `<function_calls>` 不触发 Tool 执行。
13. MiniMax 内联 `tool_calls` JSON 触发工具执行，ToolResult 进入下一次 LLM 请求。
14. 普通最终答复记录 `tool_call.parse.completed` 且 `callCount = 0`；畸形内联 JSON 记录解析失败。
15. 普通“分析当前项目”不激活 Skill；显式 `/skill project-understanding ...` 才激活。
16. Skill 预检结果只进入模型消息，不能覆盖模型最终答复或 Markdown 报告。
17. 同一响应内重复工具块、工具块与正文混用、`FINAL` 后夹带工具调用，均记为协议错误；不执行其中任何工具。
18. 协议错误只允许一次格式修复；再失败时 Turn 为 `failed`，返回可见错误，不写入完成报告。
19. 整轮工具结果没有新增证据时给出收敛提示；即使调整工具顺序，或在 `read_file` 与 `read_many_files` 之间切换，重复文件内容仍视为已见证据。连续达到配置阈值后显式失败；新证据到来时重置计数，深入调查不因固定轮数终止。
20. `read_many_files` 混合存在与缺失路径时逐项返回成功内容和失败原因；越界路径在读取前整体拒绝；模型预览截断时仍保留失败路径与错误码。
20. 工具输出完整脱敏入库，发给模型的整批结果受 `agent.toolResultBatchChars` 限制，截断时保留文件路径与原始长度。
21. 自动轮内压缩输入保留原始任务目标，且只在预期节省足够字符时触发；压缩结果不缩短消息时不得替换原消息。
22. `<tool_calls>` / `<invoke>` XML 在文本和原生模式下均不得作为最终答复展示或执行；记录解析失败，发起格式修复。原生模式的流式输出也不得提前泄露该 XML。
23. DeepSeek DSML 工具标签在文本和原生模式下均记录 `unsupported_dsml_tool_calls`，不能记为无工具最终答复；纠正成功后执行标准工具协议，连续违规按现有次数上限显式失败。逐字符分片的 DSML 前缀不得提前进入原生流式正文。

## Trace 验收

`trace.jsonl` 至少包含：

```text
turn.processing
context.build.completed
llm.called
llm.completed
skill.completed（仅显式 Skill 且预检成功时）或 skill.skipped
tool_call.parse.started
tool_call.parse.completed
tool_call.round.started
tool_call.round.completed
tool_call.result.appended
artifact.created
turn.completed
```

协议修复场景还必须出现 `tool_call.parse.failed`、`tool_call.repair.requested`；无进展场景出现 `tool_call.no_progress`。失败 Turn 以 `turn.failed` 收尾，不能写 `turn.completed`。

## 真实模型验收状态（2026-10-13）

同一隔离项目、同一分析任务的实测：DeepSeek `deepseek-flash` 和 MiniMax `MiniMax-M3` 通过文本协议完成；GPT 中转 `gpt-6.1-sol` 两次文本协议测试失败且未执行工具。改用配置驱动的原生工具调用后，GPT 中转完成真实回归：3 次模型请求、5 次实际工具调用、最终回答依据已回填的文件证据。详见 [分阶段实测记录](./PROTOCOL_REPAIR_2026-10-13.md)。**GPT 文本协议仍未通过；当前配置下的原生协议已通过一次真实任务验收。**

同日追加 DeepSeek `deepseek-v4-pro` XML 误判回归：原 Turn 的第 2 次响应被误记为 `callCount=0` 并原样完成；修复后，隔离项目真实调用 3 次模型请求、1 次格式修复、1 次 `read_many_files`，最终 Turn 为 `completed` 且答复引用了真实文件内容。XML 路径的精确复现由 `tool-call-parser`、`agent-loop-tool-calling` 与 `final-answer-stream` 自动化测试覆盖；真实调用出现的是另一种协议违规，不能据此宣称 DeepSeek 不再输出 XML。详见[事故与回归记录](./PROTOCOL_REPAIR_2026-10-13.md)。

## 桌面 DeepSeek DSML 回归（2026-10-18）

93 个测试文件、1029 项测试通过，包含本次新增的 16 项测试。新 ZIP 解压运行：注入 DSML 后由真实 `deepseek-flash` 纠正，3 次请求、1 次纠正、1 次成功读文件；另一个全真实任务为 2 次请求、0 次纠正、1 次成功读文件。两个任务均返回文件内随机标记；测试进程正常退出。首个场景的第一条响应是受控注入，不能计作真实模型自行复现 DSML。详见[根因、流程及逐请求数据](./2026-10-18-DeepSeek-DSML工具标记误完成修复验收.md)。

## 禁止放行条件

1. AgentLoop 直接读取文件。
2. AgentLoop 绕过 PluginHost 获取能力。
3. AgentLoop 绕过 Reporter 写 Markdown。
4. AgentLoop 直接执行 Tool。
5. AgentLoop 执行 `<function_calls>`。
6. AgentLoop 从自然语言中抽取 shell 命令执行。
7. 工具调用被固定轮次上限提前截断，或截断后将 Run 误记为 `completed`。
8. 用户停止 Run 后，仍继续发起新的模型或工具调用。
9. Skill 以固定“完成”文案覆盖模型基于 ToolResult 形成的拒绝或结论。
10. GPT 中转没有先获得真实 ToolResult 却被标记为项目分析完成。
11. XML 工具标签被标记为 `callCount=0` 并完成 Turn，或在格式校验前进入工作台流式正文。
12. DSML 工具标记被当作最终答复，或未经标准协议纠正直接执行其中的动作。
