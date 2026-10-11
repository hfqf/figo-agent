# 压缩策略自优化阶段一实施文档

> 状态：待实施。本文只规定后续改动，不代表功能已上线或测试已通过。执行时必须逐任务满足 [阶段一验收文档](./COMPACTION_SELF_OPTIMIZATION_PHASE1_ACCEPTANCE.md)；任一任务未通过，不进入下一任务。

**目标：** 拆分 Task 历史与同一 Turn 内工具轮次的压缩策略，完整记录实际决策，增加不影响真实行为的影子阈值评估。阶段一不自动修改阈值、不评判摘要语义质量。

**架构：** AgentLoop 在两个压缩入口分别读取明确的有效策略；纯策略函数返回结构化决策；TraceRecorder 把实际和影子决策写入现有 SQLite `trace_events` 与 JSONL。压缩执行、摘要校验和检查点持久化仍由现有模块负责。统一 JSON 是唯一人工运行配置，SQLite 只保存观测事实。

**技术栈：** TypeScript、Node 内置 `node:sqlite`、Vitest、现有 `LLMProvider`、`TraceRecorder`、`CompactionService`。

## 1. 范围和禁止事项

1. 保持冷启动默认值：Task 历史 `turnThreshold=12`、`charThreshold=24000`、`summaryMaxChars=12000`；工具轮次的有效默认字符阈值和摘要上限也保持当前数值。
2. 不实现自动调参、候选策略发布、模型能力探测、摘要语义评分、TokenUsage、额外模型调用或新 UI。
3. 影子策略只计算与记录，不调用 LLM、不写检查点、不替换 `messages`、不改变 ContextPack。
4. 已有 `/compact` 手动命令仍直接调用现有服务，不由自动触发策略拦截；手动调用不冒充一次自动策略评估。
5. 不按模型厂商名称分支触发逻辑；只记录当前启用模型的非密钥档案指纹以便后续分组。
6. 不改写用户工作区已有的配置变更；实施前检查 `git status`，修改 `code/figo-agent.config.json` 时只追加本阶段字段，不触碰现有密钥。

## 2. 现状与文件边界

| 文件 | 当前事实 | 阶段一职责 |
| :--- | :--- | :--- |
| `code/src/config/runtime-config.ts` | `context.compaction` 有四个字段；缺失配置回退默认值 | 定义并校验独立工具轮次与影子配置；保持旧配置兼容 |
| `code/figo-agent.config.json` | Task 与工具轮次目前共用顶层压缩字段 | 增加显式 `round` 和关闭状态的 `shadow` 配置；真实密钥不进提交 |
| `code/src/context/compaction-policy.ts` | 返回 `{trigger, reason}` 的纯函数 | 返回可序列化的结构化决策；Task 与工具轮次策略分离 |
| `code/src/context/compaction-service.ts` | 读取 Task 尾部、判断阈值、执行压缩 | 在每次自动判断时记录实际和影子决策；执行路径保持原样 |
| `code/src/loop/agent-loop.ts` | 每轮工具循环复用顶层 `charThreshold` 和 `summaryMaxChars` | 使用独立工具轮次策略；每次判断留下实际和影子决策 |
| `code/src/context/round-compaction.ts` | `messages.length < 6` 时不调用模型，保留原消息 | 保持行为；策略观测与该候选条件一致 |
| `code/src/contracts/types.ts` | Trace 类型未包含压缩策略评估 | 增加独立决策事件类型 |
| `code/src/trace/trace-recorder.ts` | Trace 已写入 SQLite 和 JSONL | 复用现有记录接口；不在 payload 中存请求正文或密钥 |

不新增策略状态表。阶段一观测可用 `trace_events` 按 `type`、`task_id`、`turn_id` 和时间查询；`llm_http_captures` 与原始 Turn 保持不变。若后续查询负载证明现有索引不足，再单独评估索引，不提前迁移 Schema。

## 3. 配置契约

继续以现有顶层 `context.compaction` 四字段表示 **Task 历史实际策略**。新增可选字段如下；示例值仅用于说明结构，正式实施须保留工作区现有 `llm` 与其他配置：

```json
{
  "context": {
    "compaction": {
      "autoEnabled": true,
      "turnThreshold": 12,
      "charThreshold": 24000,
      "summaryMaxChars": 12000,
      "round": {
        "autoEnabled": true,
        "charThreshold": 24000,
        "summaryMaxChars": 12000
      },
      "shadow": {
        "enabled": false,
        "taskHistory": { "turnThreshold": 12, "charThreshold": 24000 },
        "round": { "charThreshold": 24000 }
      }
    }
  }
}
```

解析规则：

1. 旧 JSON 未含 `round` 时，其有效配置继承当前顶层 `autoEnabled`、`charThreshold`、`summaryMaxChars`，保证升级前后的实际行为一致；显式 `round` 存在时，三个字段独立生效。顶层 `autoEnabled=false` 关闭 Task 自动压缩；显式 `round.autoEnabled` 独立控制工具轮次自动压缩。
2. `shadow` 缺失时关闭。`shadow.enabled=true` 时必须完整提供 `taskHistory` 与 `round` 候选阈值；缺字段或无效值启动报错，不得静默启用部分影子策略。关闭时无需提供候选。
3. 阈值与摘要上限必须为正整数；Task 的实际及影子 `turnThreshold` 均不得低于 `maxTaskHistoryTurns + 1`。沿用既有实际 Task 阈值的兼容修正规则；影子候选越界报配置错误，不自动修正，以免记录的候选值与生效值不符。
4. JSON 显式配置优先于代码默认值。阶段一没有 SQLite 学习配置或运行期阈值覆盖。启用影子模式仍不改变实际阈值。
5. 模型档案指纹由启用模型的 `id`、`provider`、`baseUrl`、`model` 与摘要协议版本计算；计算输入不含 `apiKey`，Trace 只记录指纹和允许公开的模型 ID。更换模型或端点后，观测数据在查询时分组，不混算。

## 4. 决策事件契约

新增 `compaction.policy.evaluated` Trace 类型。每个自动判断点写一条 `phase=actual`；仅当影子模式开启时，再写一条 `phase=shadow`。两条记录用同一 `decisionId` 关联，但影子记录只能标记 `executed=false`。手动 `/compact` 维持既有 `compaction.requested` 等事件。

| 字段 | 含义 |
| :--- | :--- |
| `schemaVersion=1`、`policyVersion=1` | 事件与策略算法版本；版本变化时不混算旧观测 |
| `decisionId`、`mode`、`phase` | 同一判断点关联键；`mode=task_history|round`，`phase=actual|shadow` |
| `modelProfileKey` | 不含密钥的模型档案指纹 |
| `turnCount`、`charCount`、`messageCount` | 当前模式适用的计数；不适用字段用 `null`，不能填伪造的零 |
| `eligiblePrefixCount` 或 `hasOlderRound` | 是否有可压缩候选；与现有保留原文规则一致 |
| `thresholds`、`matchedBy` | 本次实际使用的阈值，以及命中的 `turn`、`char`、`both` 或 `none` |
| `trigger`、`reasonCode`、`executed` | 纯策略结论、规范化原因和是否进入真实压缩执行路径 |

Trace 外层已有 `sessionId`、`taskId`、`turnId`、`createdAt`，不在 payload 重复保存。`reasonCode` 至少区分 `disabled`、`below_threshold`、`no_eligible_prefix`、`turn_threshold`、`char_threshold`、`both_thresholds`。Task 统计范围是最新检查点之后、当前 Turn 之前的历史；工具轮次统计范围是本次即将发给模型的完整 `messages`。若 `turnCount` 与 `charCount` 同时达到阈值，记录 `matchedBy=both`，不能按代码分支顺序只记 `turn`。

实际压缩结果仍以现有 `compaction.requested/started/completed/skipped/failed` 为事实源。阶段一需在自动路径的这些事件中附带 `decisionId`，使策略决策、LLM 请求和检查点可串联；不改变人工 `/compact` 事件结构。无阈值命中或无候选时仍保留决策事件，不能只记录成功压缩。

Trace 的 payload 只允许标量、阈值和非敏感标识；不存原始文本、提示词、HTTP Header、请求体或密钥。写入失败不得把影子结论当作实际结论，也不得产生半个检查点。阶段一维持现有真实压缩错误语义；新增观测写入失败应显式报错并由验收测试确认不造成原始历史丢失。

## 5. 时序与边界

```mermaid
sequenceDiagram
  participant Loop as AgentLoop
  participant Policy as CompactionPolicy
  participant Trace as TraceRecorder
  participant Service as CompactionService
  participant LLM as LLMProvider

  Loop->>Service: 自动检查 Task 历史
  Service->>Policy: 实际策略与历史统计
  Policy-->>Service: actual decision
  Service->>Trace: policy.evaluated(actual)
  opt 影子模式开启
    Service->>Policy: 候选阈值与同一历史统计
    Policy-->>Service: shadow decision
    Service->>Trace: policy.evaluated(shadow)
  end
  opt 实际策略触发且有候选
    Service->>LLM: 生成 Task 摘要
  end
  Loop->>Policy: 工具轮次实际与影子判断
  Loop->>Trace: 记录各自决策
  opt 仅实际轮次策略触发且有旧往返
    Loop->>LLM: 生成轮次摘要
  end
```

纯策略函数只返回决策，不读 JSON、不读 SQLite、不调用 LLM。配置解析、历史统计、观测记录和压缩执行分离，保持高内聚和可替换边界。`summaryMaxChars` 阶段一仅拆分实际 Task/轮次配置，不加入影子候选，因为不调用模型就无法评估候选摘要长度和质量。

## 6. 实施顺序与任务级门槛

### 任务 1：配置拆分与向后兼容

**修改：** `code/src/config/runtime-config.ts`、`code/figo-agent.config.json`；**测试：** `code/tests/config/runtime-config.test.ts`。

- [ ] 先写失败测试：旧配置不含 `round` 时有效轮次配置与旧顶层值一致；显式 `round` 可独立开关和设置上限；`shadow` 默认关闭；启用时必须有完整合法候选；模型切换不改变配置语义。
- [ ] 实现类型、默认值、解析和验证；只增加配置字段，不碰已有 LLM 选择和密钥。
- [ ] 在 `code/` 运行 `npm test -- --run tests/config/runtime-config.test.ts`；失败不得进入任务 2。

### 任务 2：纯决策函数与候选边界

**修改：** `code/src/context/compaction-policy.ts`；**测试：** `code/tests/context/compaction-policy.test.ts`、`code/tests/context/round-compaction.test.ts`。

- [ ] 先写失败测试：Task 阈值边界、OR 同时命中、关闭、无可压缩前缀、最近原文保留；工具轮次字符边界、`messages.length < 6` 无候选；不同模型档案输入得到相同触发结论。
- [ ] 纯函数输出完整决策，兼容现有压缩服务调用；候选影子调用复用相同输入统计，不复制一套隐藏逻辑。
- [ ] 在 `code/` 运行 `npm test -- --run tests/context/compaction-policy.test.ts tests/context/round-compaction.test.ts`；失败不得进入任务 3。

### 任务 3：Task 历史实际与影子观测

**修改：** `code/src/context/compaction-service.ts`、`code/src/contracts/types.ts`；**测试：** `code/tests/context/compaction-service.test.ts`、`code/tests/e2e/task-context-compaction.test.ts`。

- [ ] 先写失败测试：每个新 Turn 自动判断都产生实际事件；开启影子后再产生同 `decisionId` 的候选事件；影子命中但实际未命中时 LLM 调用数、检查点和 ContextPack 与影子关闭时相同；成功、失败、无候选均可按 `decisionId` 追溯。
- [ ] 实现 Task 观测，并让实际自动压缩事件携带 `decisionId`；摘要结构、短引用映射与回退逻辑不变。
- [ ] 在 `code/` 运行 `npm test -- --run tests/context/compaction-service.test.ts tests/e2e/task-context-compaction.test.ts`；失败不得进入任务 4。

### 任务 4：工具轮次独立策略与影子观测

**修改：** `code/src/loop/agent-loop.ts`、必要时 `code/src/context/round-compaction.ts`；**测试：** `code/tests/loop/agent-loop-tool-calling.test.ts`、`code/tests/context/round-compaction.test.ts`。

- [ ] 先写失败测试：旧配置无 `round` 时 Tool Calling Loop 行为不变；显式轮次关闭或改阈值只影响轮次压缩；Task 触发不受影响；影子轮次命中不增加请求、不替换消息、不推进 Task 检查点；最新 ToolResult 保留。
- [ ] 接入独立轮次策略和观测；工具每次发模型前重新计算完整消息统计，记录实际与影子判断。
- [ ] 在 `code/` 运行 `npm test -- --run tests/loop/agent-loop-tool-calling.test.ts tests/context/round-compaction.test.ts`；失败不得进入任务 5。

### 任务 5：审计查询与端到端复核

**修改：** `docs/agent/modules/context/README.md` 与本阶段验收记录；仅在实际查询证明需要时增加 `code/src/storage/schema.ts` 的索引。**测试：** `code/tests/e2e/task-context-compaction.test.ts`、相关 Trace 测试。

- [ ] 先写失败测试：重开 SQLite 后能按 Task/Turn 查询实际和影子决策；模型档案不同不混组；JSONL 与 SQLite 的决策事件可按 ID 核对；影子开关不改变抓包用途、请求数量和检查点覆盖范围。
- [ ] 补齐审计查询示例与中文验收记录；不得把文档当作运行时策略源。
- [ ] 在 `code/` 运行 `npm test`、`npm run typecheck`、`npm run build`；再按验收文档人工复核。任一证据缺失，不宣布阶段一完成。

## 7. 阶段一交付界线

完成后只能声称“Task/轮次策略已拆分，实际与影子决策可追溯，现有行为无回归”。不能声称已找到最优阈值、摘要语义质量已被证明，或自动优化已经上线。阶段二必须基于阶段一的实际数据另写实施和验收文档。
