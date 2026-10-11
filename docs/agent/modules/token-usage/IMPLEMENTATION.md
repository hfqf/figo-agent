# TokenUsage 实施文档

> V2 模块实施记录。每项实现以 [测试验收文档](./ACCEPTANCE.md) 为放行门槛；文档本身不控制运行流程。

## 目标与约束

1. 以每次 LLM HTTP 请求为统计单位，覆盖普通 Turn、Task 压缩和工具轮次压缩。
2. Provider 返回的 `usage` 才标记为实际值；ContextPack/ContextItem 和请求消息的估算与实际值分开。
3. SQLite 是结构化状态源，Markdown 只是人类可读的展示。原始抓包不可删除或覆盖。
4. 老数据库增量升级并幂等回填；所有新增时间使用上海本地时间，旧时间先迁移再投影。
5. 不读 `AGENTS.MD` 或实施文档做运行控制；不改 `code/figo-agent.config.json` 中的本地密钥。

## 模块与文件职责

| 文件 | 职责 |
| :--- | :--- |
| `code/src/storage/schema.ts` | 定义 `token_usage` 表和按 Task、Session、Turn 查询的索引 |
| `code/src/storage/storage-manager.ts` | 数据库启动后对缺失投影执行幂等回填 |
| `code/src/token-usage/token-usage-store.ts` | 解析响应、写入请求级投影、聚合与旧抓包回填 |
| `code/src/token-usage/estimate-message-tokens.ts` | 对每次完整 LLM 消息列表做明确标注的粗估 |
| `code/src/token-usage/format-token-usage.ts` | 把已知值、缺失值与覆盖次数格式化为中文 |
| `code/src/llm/llm-http-capture-store.ts` | 在同一事务中写原始抓包及其用量投影 |
| `code/src/loop/agent-loop.ts` | 每次请求前重新估算整个消息列表，不复用 ContextPack 估算 |
| `code/src/cli/input-router.ts`、`code/src/kernel/agent-kernel.ts` | `/usage` 命令路由和当前 Task/Session 查询；不创建 Turn |
| `code/src/reporter/markdown-reporter.ts` | Turn/Task 的实际用量和上下文估算展示 |

## SQLite 契约

`token_usage` 以抓包 ID 为主键，`request_id` 唯一。字段包含 Session/Task/抓包 Turn 锚点、`usage_turn_id`、purpose、provider、model、三个可空 token 值、`status` 和 `created_at`。单次新请求的抓包与用量投影同事务提交，重复新 `request_id` 整体回滚。对旧抓包只补缺失记录，不重写已有用量或响应体。

`usage_turn_id` 是用量归属，不等同于抓包锚点：自动 Task 压缩归发起的当前 Turn；手动 `/compact` 设为 `NULL`，只计入 Task 和 Session；历史 Task 压缩无法从旧抓包确定触发 Turn，回填时不猜测。普通请求与轮次压缩归各自的 Turn。升级早期 `token_usage` 表时先补可空列，再建索引；旧的非 Task 压缩记录按锚点补归属。

`status=complete` 当且仅当输入、输出、总量三个字段均为有效非负安全整数；至少一个有效时为 `partial`；全部缺失/无效时为 `unavailable`。聚合分别计算三个字段的已知和与提供次数；没有实际值时展示“未提供”，不是 0。多模型和压缩用途只作为维度，不改变口径。

## 实施任务与测试门槛

### 任务 1：请求级投影与旧库回填

- [x] 先写失败测试：有效、部分、缺失、零值、无效数值、跨 Task/Session 隔离及重复重启。
- [x] 实现表、同事务写入、旧抓包回填及汇总查询。
- [x] 定向测试：`tests/token-usage/token-usage-store.test.ts`、`tests/storage/storage-manager.test.ts`、`tests/llm/openai-compatible-provider.test.ts`。

### 任务 2：用户查询与报告

- [x] 先写失败测试：`/usage` 不创建 Turn，报告区分 ContextPack 估算与实际用量。
- [x] 实现 CLI 当前 Task/Session 查询；Turn 和 Task Markdown 汇总。
- [x] 定向测试：`tests/cli/input-router.test.ts`、`tests/kernel/agent-kernel.test.ts`、`tests/reporter/markdown-reporter.test.ts`。

### 任务 3：多轮输入估算修正

- [x] 先写失败测试：工具结果回灌后第二次请求的输入估算大于第一次。
- [x] 每次 `llm.complete` 前基于实际 `messages` 计算估算，并写入 LLMRequest 与 Trace。
- [x] 定向测试：`tests/loop/agent-loop-tool-calling.test.ts`。

## 验收界线

通过测试后仅能声称：对当前 OpenAI-compatible Provider 的响应 `usage` 完成请求级统计和展示，旧抓包可回填；不能声称所有模型都提供 `usage`、估算等于计费值、或已经实现单个 Tool/Skill 的准确分摊。
