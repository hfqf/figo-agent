# TokenUsage 模块设计

## 定位与文档入口

TokenUsage 负责回答三类问题：每次模型请求实际消耗多少 token、哪些请求没有返回用量、构造的上下文预计占多少。它是观测模块，不控制上下文取舍、压缩时机或模型选择。

- [实施文档](./IMPLEMENTATION.md)：数据契约、模块边界和实施步骤。
- [测试验收文档](./ACCEPTANCE.md)：自动化与人工核查、禁止放行条件。

旧 V1 文档中的“每 Turn 只调用一次 LLM”仅适用于早期设计；当前代码支持多轮 Tool Calling 和 Task/轮次压缩，统计单位必须是**一次 LLM HTTP 请求**。原先以项目理解场景估算的 token 数值不属于实测结论，不用作当前默认值或验收依据。

## 口径与边界

| 指标 | 来源 | 含义 |
| :--- | :--- | :--- |
| `prompt_tokens`、`completion_tokens`、`total_tokens` | HTTP 响应 `usage` | Provider 报告的实际值；缺失保持 `NULL`，不以估算替代 |
| `status` | TokenUsage 解析器 | `complete` 三字段齐全；`partial` 至少一字段有效；`unavailable` 没有有效字段 |
| ContextPack / ContextItem `estimated_tokens` | ContextBuilder | 内容字符启发式估算，不是 Provider 计费值 |
| 每次请求 `estimatedInputTokens` | AgentLoop | 即将发送的完整 `messages` 估算值，多轮时重新计算；与 ContextPack 估算不可相加 |

同一请求的 `total_tokens` 不再与输入、输出 token 求和一次；三者分别展示。聚合结果只累加响应明确提供的字段，并显示字段覆盖次数及缺失请求数。`0` 是有效的真实数值；负数、小数、字符串和超过安全整数范围的值无效。没有 `usage` 的 HTTP 错误或本地占位响应计为 `unavailable`，不能显示为“消耗 0”。

按 `session_id`、`task_id`、`usage_turn_id` 汇总，按 `purpose=turn|task_compaction|round_compaction` 保留请求用途。多模型使用同一通用解析契约；响应中优先读取 `prompt_tokens` / `completion_tokens`，也接受 `input_tokens` / `output_tokens`。不依赖模型厂商名称判断 token。模型细分字段如 reasoning、cache 暂保存在原始抓包中，不额外加到 `total_tokens`，以免重复计数。

`token_usage.turn_id` 保留原始抓包的 Turn 锚点；按 Turn 汇总实际使用 `usage_turn_id`。普通对话和轮次压缩归当前 Turn；自动 Task 压缩归触发压缩的当前 Turn；手动 `/compact` 不创建 Turn，`usage_turn_id=NULL`，只进入 Task/Session 汇总。旧抓包没有独立的触发 Turn 信息，回填的 Task 压缩保持 `usage_turn_id=NULL`，不猜测归属。

ContextSource 的间接占用通过 `ContextItem.sourceType` 的估算值呈现。当前 Skill 在模型循环之后运行，不向当轮 LLM 请求增加独立 Prompt；Tool 结果作为后续消息回灌，但不能从总实际 token 中精确分摊到单个 Tool。因此本版不展示未经验证的“每个 Skill/Tool 实际消耗”。

## 架构图

```mermaid
flowchart LR
  A[ContextBuilder] -->|ContextPack / Item 估算| R[MarkdownReporter]
  B[AgentLoop 消息列表] -->|每轮请求估算| P[LLMProvider]
  P -->|请求与响应| C[LLMHttpCaptureStore]
  C -->|同一事务| H[(llm_http_captures)]
  C -->|解析 usage| U[(token_usage)]
  H -->|旧抓包幂等回填| U
  U --> Q[TokenUsageStore 聚合]
  Q --> R
  Q --> CLI[/usage]
```

`TokenUsageStore` 只依赖存储接口，解析和聚合集中在本模块。`LLMHttpCaptureStore` 是新请求的数据入口；原始响应仍是审计事实源，`token_usage` 是可重建的结构化投影。现有 ContextPack/ContextItem 估算表不重复写进 `token_usage`。

## 数据流与状态

```mermaid
sequenceDiagram
  participant Loop as AgentLoop
  participant Provider as LLMProvider
  participant Capture as LLMHttpCaptureStore
  participant Usage as TokenUsageStore
  participant DB as SQLite

  Loop->>Loop: 估算本轮完整消息
  Loop->>Provider: complete(request)
  Provider->>Capture: record(request, response)
  Capture->>DB: BEGIN; 写入原始抓包
  Capture->>Usage: 解析响应 usage
  Usage->>DB: 写入一条请求级 token_usage
  Capture->>DB: COMMIT
  DB-->>Loop: 查询 Task / Turn / Session 汇总
```

旧数据库启动时先运行现有 Schema 与上海时间迁移，再按缺失的 `request_id` 回填 `token_usage`；重启不产生重复记录，不改写原始响应。时间字段沿用 `YYYY-MM-DD HH:mm:ss.SSS`。

## 使用方式

- CLI `/usage`：查看当前 Task 和当前 Session 的请求数、完整/部分/缺失数及已知的输入、输出、总量。
- `report.md`：查看本 Turn 的 ContextPack 与来源类型估算，以及本 Turn 所有普通/压缩 LLM 请求的实际汇总。
- `task-summary.md`：查看 Task 的 LLM 请求索引和用量汇总。
- SQLite `token_usage`：按 `request_id` 关联 `llm_http_captures`，检查每次请求的模型、用途与原始响应。

## 非目标与后续研究

本版不引入价格表、汇率、按模型窗口控制压缩、跨 Provider 计费换算、单个 Skill/Tool 的实际用量分摊或每类缓存/推理细项的独立报表。后续若要分析缓存命中和推理开销，应先核对各端点字段语义，再扩展规范化字段；原始抓包允许重新构建投影。

经验结论：**实测、估算和未知必须三分**。只给一个“总 token”而不展示用量覆盖率，会把缺失响应误解为低消耗；在多轮工具调用与摘要请求存在时，还会漏算整个 AgentLoop 的额外调用。
