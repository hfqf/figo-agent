# TokenUsage 测试验收

## 放行规则

任务 1 至任务 3 的定向测试按顺序通过后，再跑全量测试、类型检查、构建和 SQLite/Markdown 人工复核。任一失败，不宣布 TokenUsage 可用。当前结果栏在实际执行后填写，不预设通过。

## 自动化命令

在 `code/` 目录运行：

```bash
npm test -- --run tests/token-usage/token-usage-store.test.ts tests/storage/storage-manager.test.ts tests/llm/openai-compatible-provider.test.ts tests/llm/llm-http-capture-store.test.ts
npm test -- --run tests/cli/input-router.test.ts tests/kernel/agent-kernel.test.ts tests/reporter/markdown-reporter.test.ts tests/loop/agent-loop-tool-calling.test.ts
npm test
npm run typecheck
npm run build
```

## 必验场景

1. 同一请求的原始抓包与用量投影原子写入；`request_id` 可关联，重启回填不重复，不修改抓包。
2. 普通 Turn、Task 压缩、轮次压缩和 HTTP 失败/本地占位均有请求级用量状态；无 `usage` 时为 `unavailable`。
3. `0` 是有效值；负数、小数、字符串和超出安全整数范围的数字不作为真实 token。
4. 部分字段保留已知值并标记 `partial`；汇总显示每个字段的提供次数，不把未知值补零。
5. 当前 Task、其他 Task、当前 Session、其他 Session 与 Turn 的聚合互不串数据。
6. 旧 V1 Schema 无 `purpose`、`task_id` 的抓包在升级后默认归属 `turn`，旧 ISO 时间迁移为上海毫秒文本后再回填。
7. `/usage` 不创建 Turn；`report.md` 与 `task-summary.md` 清楚区分 Context 估算和模型实测；工具循环每轮按实际消息重估输入。
8. 本地配置密钥不进入代码、文档、Trace、新增表或测试快照；新增表只存用量与引用，不复制请求/响应正文。
9. 抓包 `turn_id` 与用量 `usage_turn_id` 分开；自动 Task 压缩归当前 Turn，手动 `/compact` 不归属任何 Turn，旧 Task 压缩回填不猜测触发 Turn。

## 人工复核

在隔离工作区执行带 `usage` 的普通 Turn、至少一次没有 `usage` 的请求，以及 Task 压缩或多轮工具调用。查看 `llm_http_captures` 和 `token_usage` 的 `request_id`、purpose、model、状态、数值；核对 `/usage`、本轮 `report.md` 和 `task-summary.md`。重开数据库，确认回填稳定、原始抓包未改、时间格式为 `YYYY-MM-DD HH:mm:ss.SSS`。

不把模型返回的 cache/reasoning 细项另外加到 `total_tokens`；对同一响应核对输入、输出、总量展示一次。若样本中无真实模型 `usage`，验收结论须明确标为“仅替身响应已验证”，不能写成真实多模型验收。

## 禁止放行条件

1. 缺失 `usage` 的请求被显示成“实际 0 token”。
2. 把 ContextPack 或请求字符估算与 Provider 实际用量直接相加，或把 `total_tokens` 再加一次输入/输出。
3. 任一压缩用途的模型调用未进入请求级统计，或 Task/Session 归属错误。
4. 旧库升级删除/改写原始抓包，或重复启动生成重复用量行。
5. 只跑单元测试，没有检查 SQLite、CLI 和 Markdown 三处的一致性。
6. 任一必需测试、类型检查、构建或密钥检查未通过。

## 2026-10-11 验收记录

- 自动化：全量 Vitest 38 个测试文件、117 项测试通过；`npm run typecheck`、`npm run build` 通过。重复 `request_id` 的事务回滚、压缩用量归属、旧表补列与分批回填均有回归测试；最终全量数量以最后一轮复测为准。
- 隔离工作区端到端：创建一个无密钥的普通 Turn 后，`token_usage` 有一条 `purpose=turn`、`status=unavailable`、三个 token 字段均为 `NULL` 的记录；`/usage` 同时显示当前 Task 和 Session 各 1 次未提供；`report.md` 标出 ContextPack 估算与“实际输入 Token：未提供”；`task-summary.md` 有模型用量节。测试目录执行后已清理。
- 真实模型短请求：当前 `gpt-relay / gpt-5.6-sol` 返回输入 21、输出 5、总量 26，SQLite 状态 `complete`；`minimax / MiniMax-M3` 返回输入 180、输出 35、总量 215，状态 `complete`。两次请求均在隔离临时数据库执行，没有写入项目 Session，也没有输出密钥或请求正文。
- 旧库回填：V1 缺少 `task_id`、`purpose` 的抓包在测试中先完成上海时间迁移，再回填为 `purpose=turn` 的用量记录；重复重启保持单条，不修改原始响应。

**结论：** 请求级 TokenUsage 的入库、查询、回填和展示链路通过上述核查；缓存/推理细项和单个 Tool/Skill 的实际归因仍不在本版范围。
