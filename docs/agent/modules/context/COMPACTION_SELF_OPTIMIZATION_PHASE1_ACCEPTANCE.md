# 压缩策略自优化阶段一测试验收文档

> 状态：待实施、待验收。以下是放行标准，不是测试结果。对应实施步骤见 [阶段一实施文档](./COMPACTION_SELF_OPTIMIZATION_PHASE1_IMPLEMENTATION.md)。

## 1. 放行规则

按实施任务 1 至任务 5 顺序验收；当前任务的定向测试未通过，不进入下一任务。最终必须同时通过全量测试、类型检查、构建、SQLite/JSONL 人工核查与行为对照。不得因影子日志已写入就宣布自优化完成；阶段一只放行观测和影子评估。

实施前记录 `git status --short`，识别用户已有改动。`code/figo-agent.config.json` 含本地密钥时，不能将密钥加入提交、测试快照、Trace、文档或终端展示；最终检查暂存差异。

## 2. 自动化命令

在 `code/` 目录运行：

```bash
npm test -- --run tests/config/runtime-config.test.ts
npm test -- --run tests/context/compaction-policy.test.ts tests/context/round-compaction.test.ts
npm test -- --run tests/context/compaction-service.test.ts tests/e2e/task-context-compaction.test.ts
npm test -- --run tests/loop/agent-loop-tool-calling.test.ts tests/context/round-compaction.test.ts
npm test
npm run typecheck
npm run build
```

若新增专门的 Trace 测试文件，也必须纳入定向命令和全量测试。命令退出码全为 0 才满足自动化门槛；测试数与日期由实际执行结果填写，不能预填通过。

## 3. 配置与兼容性

- [ ] 不含 `round`/`shadow` 的旧 JSON 与升级前 Task、工具轮次真实压缩行为一致；旧顶层值能完整映射为轮次有效值。
- [ ] 显式 `round.autoEnabled=false` 只关闭工具轮次自动压缩；显式 `round.charThreshold` 与 `round.summaryMaxChars` 只作用于轮次；Task 配置变更不越界影响显式轮次配置。
- [ ] `shadow` 缺失或关闭时不产生影子决策；启用时缺字段、非正整数或 Task 候选阈值越界均在配置加载阶段报错，不能静默使用部分候选。
- [ ] JSON 配置是唯一人工策略源；SQLite 观测不覆盖阈值；`activeModelId` 切换只改变观测档案，不触发厂商专属策略。
- [ ] 本地密钥及认证信息不出现在 Trace payload、JSONL、测试快照和新增文档。

## 4. 决策与行为对照

- [ ] Task 历史在每个新 Turn 的自动判断点都记录一条 `phase=actual`；阈值未命中、自动关闭、命中但无可压缩前缀均有明确 `reasonCode`。
- [ ] 工具轮次在每次 LLM 调用前记录实际判断；同时达到两个 Task 阈值时 `matchedBy=both`，不因分支顺序漏记。
- [ ] 影子开启后，同一判断点有同 `decisionId` 的实际与影子记录；影子记录的 `executed=false`。影子关闭后没有影子记录。
- [ ] 用同一组固定 Task 和 Tool 消息，分别在影子关闭、影子阈值低于实际、影子阈值高于实际三种配置下运行；真实 LLM 请求数、请求用途、检查点覆盖范围、最终 ContextPack 和工具消息保持一致。
- [ ] `/compact` 仍可手动执行，且不伪造自动策略决策。Task 历史压缩失败时原始 Turn 完整；轮次压缩失败时原始 `messages` 完整。
- [ ] Task 检查点只覆盖已终结的连续前缀；轮次摘要不写 Task 检查点；最新 ToolResult 原文保留。

## 5. SQLite、Trace 与模型隔离复核

在隔离工作区执行至少一组实际 Task 自动压缩边界、一组同一 Turn 多工具轮次、一组影子阈值与实际阈值决策相反的场景。重开 SQLite 后按 `task_id`、`turn_id` 和 `type='compaction.policy.evaluated'` 查询，再按 `decisionId` 对照 JSONL 事件。逐项核对 `schemaVersion`、`policyVersion`、`mode`、`phase`、计数、阈值、候选状态、`matchedBy`、`trigger`、`reasonCode`、`executed`、模型档案指纹。

实际触发时，`decisionId` 必须串起压缩请求、成功/失败事件及对应检查点或失败回退；未触发时不能出现由该决策导致的 LLM 压缩请求。切换当前启用模型后，模型档案指纹应不同；同一历史统计与同一阈值下，触发结论应相同。原始 Turn、HTTP 抓包和旧检查点必须仍可读取。

## 6. 禁止放行条件

1. 影子候选参与了真实执行，改变请求数量、消息内容、ContextPack 或检查点。
2. 旧配置升级后真实压缩行为改变，或 Task/工具轮次的显式配置互相串扰。
3. 只记录触发成功的压缩，不记录未触发、关闭和无候选判断。
4. 事件无法按 `decisionId` 关联，或错误地把模型差异当成厂商硬编码触发规则。
5. Trace/SQLite/JSONL 出现密钥、请求正文或不应记录的原始上下文。
6. 压缩或观测失败后原始历史丢失，或出现“检查点写入失败但日志显示成功”。
7. 任一定向测试、全量测试、类型检查、构建或人工 SQLite/Trace 复核未通过。

## 7. 验收记录模板

实施完成后另行填写：实施提交、测试日期与命令结果、测试文件/用例数、隔离工作区与数据库路径、实际/影子对照摘要、模型切换复核、密钥扫描结果、遗留风险和最终放行结论。没有这些实测证据时，本文件保持“待验收”。
