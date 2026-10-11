# AgentLoop Tool Calling Loop 设计

## 1. 设计定位

Tool Calling Loop 是 AgentLoop 的核心执行循环，用于把模型的工具调用意图转化为受控、可追踪、可复盘的真实动作。

本设计遵循 Pi 式小内核思路：

```text
AgentLoop 只管理循环状态和执行边界
ToolCallingRuntime 只管理工具调用协议
ToolRegistry + Policy 是唯一动作执行面
```

模型输出不是授权。模型只能提出 ToolIntent，Policy 允许后 ToolRegistry 执行动作。

## 2. 设计目标

1. 解决模型输出伪 `<function_calls>` 文本但系统未执行 Tool 的问题。
2. 解决 ContextPack 已存储历史内容，但 LLM 请求只发送摘要的问题。
3. 建立有上限的工具调用循环，支持 LLM -> Tool -> LLM 的闭环。
4. 保持 AgentLoop 小内核，不把工具细节塞入主循环。
5. 每一轮 LLM 调用、ToolCall、PolicyDecision、ToolResult 都有 Trace 证据。
6. 为后续 Wireshark 风格大模型交互解析界面提供稳定事件链。

## 3. 核心原则

1. AgentLoop 不直接执行工具。
2. AgentLoop 不解析具体工具参数语义。
3. ToolCallingRuntime 解析工具调用协议并组织工具批次。
4. ToolRegistry 是唯一工具执行入口。
5. Policy 是唯一权限判断入口。
6. ContextItem 的 `content` 必须进入 LLM 请求。
7. ToolResult 进入下一轮 LLM 前必须摘要化和截断。
8. 循环必须有最大轮次，默认 `maxToolRounds = 3`。
9. 所有循环状态迁移必须写入 Trace。

## 4. 架构分层

```text
AgentLoop
  - 管理 Turn 级状态机
  - 调用 ContextBuilder
  - 调用 LLMProvider
  - 调用 ToolCallingRuntime
  - 调用 Reporter

ToolCallingRuntime
  - 解析 ToolIntent
  - 校验 callId
  - 调用 ToolRegistry
  - 汇总 ToolResult
  - 构造 tool result message

ToolRegistry
  - 查找 Tool
  - 调用 Policy
  - 执行 Tool
  - 记录 tool / policy Trace

Policy
  - 判断 action 是否允许
  - 判断资源边界
  - 判断危险命令
  - 返回 PolicyDecision
```

## 5. 总流程

```mermaid
flowchart TD
  Start[Turn received] --> Context[Build ContextPack]
  Context --> BuildMessages[Build LLM messages with ContextItem.content]
  BuildMessages --> LLM[Call LLM]
  LLM --> Parse[Parse ToolIntent]
  Parse --> HasTool{Has tool calls?}
  HasTool -->|No| Final[Final answer]
  HasTool -->|Yes| Limit{round < maxToolRounds?}
  Limit -->|No| RoundLimit[Stop with loop limit result]
  Limit -->|Yes| Execute[ToolCallingRuntime executes batch]
  Execute --> Results[Build tool result messages]
  Results --> LLM
  Final --> Report[Write report/context artifacts]
  RoundLimit --> Report
  Report --> Complete[Turn completed]
```

## 6. 状态机

```mermaid
stateDiagram-v2
  [*] --> BuildingContext
  BuildingContext --> CallingLLM
  CallingLLM --> ParsingToolCalls
  ParsingToolCalls --> ComposingFinalAnswer: no tool calls
  ParsingToolCalls --> ExecutingTools: valid tool calls
  ParsingToolCalls --> ToolParseFailed: invalid tool calls
  ExecutingTools --> AppendingToolResults
  AppendingToolResults --> CallingLLM: next round
  CallingLLM --> ToolRoundLimited: max rounds reached
  ToolParseFailed --> Reporting
  ToolRoundLimited --> Reporting
  ComposingFinalAnswer --> Reporting
  Reporting --> Completed
  BuildingContext --> Failed
  CallingLLM --> Failed
  ExecutingTools --> Failed
  Reporting --> Failed
  Completed --> [*]
  Failed --> [*]
```

## 7. 时序图

```mermaid
sequenceDiagram
  participant UserCli as CLI
  participant AgentLoop as AgentLoop
  participant Context as ContextBuilder
  participant Model as LLMProvider
  participant ToolRuntime as ToolCallingRuntime
  participant Tools as ToolRegistry
  participant Guard as Policy
  participant Report as Reporter
  participant TraceStore as TraceRecorder

  UserCli->>AgentLoop: submitTurn
  AgentLoop->>TraceStore: record turn.processing
  AgentLoop->>Context: build context
  Context-->>AgentLoop: context pack
  AgentLoop->>TraceStore: record context.build.completed
  AgentLoop->>Model: complete with context content
  Model-->>AgentLoop: llm response
  AgentLoop->>TraceStore: record llm.completed
  AgentLoop->>ToolRuntime: parse and execute tool calls
  ToolRuntime->>TraceStore: record tool_call.parse.completed
  ToolRuntime->>Tools: execute tool
  Tools->>Guard: evaluate policy
  Guard-->>Tools: policy decision
  Tools-->>ToolRuntime: tool result
  ToolRuntime->>TraceStore: record tool_call.round.completed
  ToolRuntime-->>AgentLoop: tool result messages
  AgentLoop->>Model: complete with tool results
  Model-->>AgentLoop: final llm response
  AgentLoop->>Report: write turn artifacts
  Report-->>AgentLoop: artifacts
  AgentLoop->>TraceStore: record turn.completed
  AgentLoop-->>UserCli: turn result
```

## 8. ToolIntent 协议

第一版使用模型无关的 JSON 协议。提示词要求模型只输出 fenced JSON；解析器也接受 MiniMax 在说明文字后输出的内联 JSON 工具调用。

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

解析规则：

1. 只解析 `type = "tool_calls"` 的 JSON。
2. 优先解析 fenced JSON 代码块；没有代码块时，定位内联 `type = "tool_calls"` 的完整 JSON 对象。
3. 不解析 `<function_calls>`。
4. 不从自然语言中抽取命令。
5. `id`、`name`、`input` 缺失时返回解析失败。
6. 同一轮内 `id` 必须唯一。
7. 内联 JSON 不完整或格式错误时返回解析失败，不把“正在查询”当作最终答复。

## 9. ToolResult 回填协议

ToolResult 进入下一轮 LLM 时使用结构化消息：

```json
{
  "type": "tool_results",
  "results": [
    {
      "id": "call_1",
      "name": "system_info",
      "status": "completed",
      "summary": "darwin arm64, 10 CPU cores, 36GB memory",
      "output": {
        "platform": "darwin",
        "arch": "arm64",
        "cpuCount": 10
      }
    }
  ]
}
```

回填规则：

1. `output` 按工具类型做大小限制。
2. `stdout`、`stderr` 进入 LLM 前截断。
3. 敏感字段进入 LLM 前脱敏。
4. failed / denied 结果也要回填给 LLM。
5. 回填消息同时写入 Trace。

## 10. 循环伪代码

```ts
const maxToolRounds = 3;
const messages = buildInitialMessages(input, contextPack);
let finalContent = "";

for (let round = 0; round <= maxToolRounds; round++) {
  const response = await llm.complete({ messages });
  const parsed = toolCallParser.parse(response.content);

  if (parsed.kind === "none") {
    finalContent = response.content;
    break;
  }

  if (parsed.kind === "invalid") {
    finalContent = renderToolParseError(parsed.error);
    break;
  }

  if (round === maxToolRounds) {
    finalContent = renderToolRoundLimit(parsed.calls);
    break;
  }

  const toolResults = await toolCallingRuntime.executeBatch(parsed.calls, toolContext);
  messages.push(buildAssistantToolCallMessage(parsed.calls));
  messages.push(buildToolResultMessage(toolResults));
}
```

## 11. Trace 事件

新增事件类型建议：

```text
tool_call.parse.started
tool_call.parse.completed
tool_call.parse.failed
tool_call.round.started
tool_call.round.completed
tool_call.round.limited
tool_call.result.appended
```

每次 `tool_call.parse.started` 均以 `tool_call.parse.completed` 或 `tool_call.parse.failed` 结束。普通最终答复记录 `tool_call.parse.completed`，其中 `callCount = 0`。

沿用事件：

```text
llm.called
llm.completed
llm.failed
policy.evaluated
policy.denied
tool.called
tool.completed
tool.failed
tool.denied
turn.completed
turn.failed
```

关键 payload：

```ts
{
  round: number;
  callId: string;
  toolName: string;
  status: "completed" | "failed" | "denied";
  inputSummary: Record<string, unknown>;
  outputSummary: Record<string, unknown>;
}
```

## 12. 失败处理

### 12.1 ToolCall 解析失败

处理方式：

1. 记录 `tool_call.parse.failed`。
2. 不执行任何工具。
3. 返回可解释回复，说明工具调用格式错误。
4. 报告中保留原始模型输出摘要。

### 12.2 Tool 被 Policy 拒绝

处理方式：

1. ToolRegistry 记录 `policy.denied` 和 `tool.denied`。
2. ToolCallingRuntime 将 denied 结果回填给 LLM。
3. LLM 基于拒绝原因生成最终回答。

### 12.3 Tool 执行失败

处理方式：

1. ToolRegistry 记录 `tool.failed`。
2. ToolCallingRuntime 将失败摘要回填给 LLM。
3. LLM 生成解释和下一步建议。

### 12.4 超过工具调用轮次

处理方式：

1. 记录 `tool_call.round.limited`。
2. 停止继续执行工具。
3. 返回已经完成的工具结果和未完成原因。

## 13. 安全边界

1. 自然语言中的 shell 命令不执行。
2. `<function_calls>` 不执行。
3. JSON 协议解析失败不执行。
4. ToolRegistry 不允许绕过 Policy。
5. `run_command` 必须限制 cwd 在 workspace 内。
6. `run_command` 必须有 timeout 和输出截断。
7. 网络、浏览器、写文件、Git 写操作进入 Tool Loop 时必须保留完整 Trace。
8. 后续增加用户确认时，确认逻辑属于 Policy profile，不属于 AgentLoop。

## 14. V1.2 落地范围

第一阶段接入以下工具：

1. `system_info`
2. `path_stat`
3. `read_file`
4. `read_many_files`
5. `workspace_summary`
6. `run_command`

第二阶段接入以下工具：

1. `write_file`
2. `apply_patch`
3. `git_add`
4. `git_commit`
5. `network_fetch`
6. `browser_open`
7. `browser_snapshot`

说明：第二阶段工具已存在于 Tool 层，进入自动 Tool Calling Loop 前需要补齐更细的风险等级、输入摘要和验收测试。

## 15. 验收标准

必须通过：

1. LLM 请求中包含 `ContextItem.content`，不是只包含 `summary`。
2. 模型返回合法 tool call JSON 时，Trace 出现 `tool_call.parse.completed`。
3. 工具执行前出现 `policy.evaluated`。
4. 工具执行成功后出现 `tool.called` 和 `tool.completed`。
5. ToolResult 进入第二轮 LLM 请求。
6. MiniMax 返回说明文字加内联 JSON 时，工具先执行，模型再生成最终答复。
7. 最终回复使用 ToolResult，不再停在“命令正在执行中”。
8. 非法 `<function_calls>` 不触发工具执行。
9. 超过 `maxToolRounds` 时停止循环并写入 `tool_call.round.limited`。
10. `turn_0db...` 类追问场景中，LLM 请求能看到历史 Turn 内容。

## 16. 测试用例

1. `buildMessages` 包含历史 turn 内容。
2. `ToolCallParser` 解析合法 JSON。
3. `ToolCallParser` 拒绝 `<function_calls>`。
4. `ToolCallingRuntime` 执行 `system_info` 并返回结构化 ToolResult。
5. `AgentLoop` 在一轮 tool call 后进行第二次 LLM 调用。
6. `AgentLoop` 在无 tool call 时直接返回最终回答。
7. `AgentLoop` 在超过轮次时停止。
8. `run_command` 仍经过 ControlledToolPolicy。
9. 当前事故回归测试：用户要求查询本机配置，最终报告包含真实 ToolResult。

## 17. 后续演进

1. 接入模型厂商 native tool calling adapter。
2. 增加 Policy profile 和风险等级。
3. 增加用户确认节点。
4. 增加 ToolResult 压缩器。
5. 增加 tool_calls SQLite 完整记录。
6. 增加 Wireshark 风格 UI 所需的调用链查询接口。

## 18. 故障复盘：内联 JSON 被当成最终答复

`ses_853d48cd-2f64-45b4-9c53-cce219280445` 的 `turn_712b6f32-80c5-490d-845d-36b576cb196a` 已标记 `completed`。LLM 返回说明文字及内联 `browser_open`、`system_info` 调用，但 Trace 只有 `tool_call.parse.started`，没有工具执行事件。原解析器只读取 fenced JSON，因此将该响应判定为普通答复，终端停在“先获取信息”的提示。

经验：工具调用协议既要约束模型输出，也要按实际模型响应验收解析器。`parse.started` 必须有终态事件，才能从 Trace 区分“没有工具调用”“解析失败”和“工具仍在执行”。已完成的 Turn 不会在后台继续执行；修复后需发起新 Turn 验证。
