# Tool Calling Loop 设计规格

## 背景

排查 `task_228d8781-1a08-45db-b647-b6182a89e5d7` 时确认两个问题：

1. 模型输出 `<function_calls>` 和“命令正在执行中”，但系统没有真实执行 Tool。
2. ContextPack 在 SQLite 中保存了历史 Turn 内容，但 LLM 请求只发送了 `sourceRef + summary`，没有发送 `content`。

本规格定义 Tool Calling Loop 的目标架构。完整模块设计见：

- `docs/agent/modules/agent-loop/TOOL_CALLING_LOOP.md`

## 目标

1. AgentLoop 支持 LLM -> Tool -> LLM 的受控循环。
2. Tool 调用协议模型无关。
3. Tool 执行统一经过 ToolRegistry 和 Policy。
4. 所有循环状态可通过 Trace 复盘。
5. LLM 请求包含真实上下文内容。

## 非目标

1. 不在 AgentLoop 中直接执行工具。
2. 不解析自然语言中的 shell 命令。
3. 不执行 `<function_calls>`。
4. 不在第一阶段接入用户确认 UI。
5. 不把厂商 native function calling 作为第一版依赖。

## 推荐设计

采用 Pi 式小内核结构：

```text
AgentLoop
  -> LLMRequestBuilder
  -> LLMProvider
  -> ToolCallParser
  -> ToolCallingRuntime
  -> ToolRegistry + Policy
  -> ToolResultMessageBuilder
  -> LLMProvider
  -> Reporter
```

AgentLoop 只管理状态机和循环边界。ToolCallingRuntime 管理工具调用协议。ToolRegistry + Policy 是唯一动作执行面。

## ToolIntent 协议

模型必须输出 fenced JSON：

```json
{
  "type": "tool_calls",
  "calls": [
    {
      "id": "call_1",
      "name": "system_info",
      "input": {}
    }
  ]
}
```

解析器只接受严格 JSON，不接受 XML、Markdown 自然语言命令、`<function_calls>`。

## 循环规则

1. 默认 `maxToolRounds = 3`。
2. 每轮先调用 LLM。
3. 无 ToolCall 时结束并返回最终回答。
4. 有 ToolCall 时执行 ToolRegistry。
5. ToolResult 以结构化消息回填给 LLM。
6. 超过轮次时停止，记录 `tool_call.round.limited`。

## 第一阶段范围

接入：

1. `system_info`
2. `path_stat`
3. `read_file`
4. `read_many_files`
5. `workspace_summary`
6. `run_command`

保留到第二阶段：

1. `write_file`
2. `apply_patch`
3. Git 写操作
4. 网络
5. 浏览器

## 验收标准

1. LLM 请求包含 `ContextItem.content`。
2. 合法 ToolIntent 触发 `tool_call.parse.completed`。
3. Tool 执行触发 `policy.evaluated`、`tool.called`、`tool.completed`。
4. ToolResult 进入第二轮 LLM 请求。
5. 非法 `<function_calls>` 不触发工具执行。
6. 当前本机配置查询场景返回真实 ToolResult，不返回“命令正在执行中”。

## 自审结果

1. 无未完成标记和占位章节。
2. 架构分层和模块职责一致。
3. 第一阶段范围聚焦 Tool Calling Loop，不混入用户确认 UI。
4. 高风险工具保留在第二阶段进入自动循环，避免第一阶段协议未稳定时放大风险。
