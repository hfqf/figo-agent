# V1 CLI Harness 验收报告

> 历史记录：下文提到的 `figo-wiki` 子模块是 2026-10-11 验收时的状态；当前主仓库已移除该依赖。

## 基本信息

- 日期：2026-10-11
- 分支：`v1-cli-harness-implementation`
- 计划来源：`docs/superpowers/plans/2026-10-10-v1-cli-harness.md`
- 验收对象：V1 本地 CLI agent harness

## 实现范围

V1 已实现以下模块：

1. CLI / REPL：`src/cli/`
2. AgentKernel：`src/kernel/`
3. AgentLoop：`src/loop/`
4. PluginHost：`src/plugin/`
5. Storage：`src/storage/`
6. Trace：`src/trace/`
7. LLM / Policy：`src/llm/`、`src/policy/`
8. Tool：`src/tools/`
9. Context：`src/context/`
10. Memory：`src/memory/`
11. Skill：`src/skill/`
12. Reporter：`src/reporter/`

V1 当前能力：

1. 启动命令行 REPL。
2. 创建 Session 和 Turn。
3. 使用 SQLite 作为状态源。
4. 写入结构化 TraceEvent，并追加 `trace.jsonl`。
5. 构造最小 ContextPack。
6. 通过静态 PluginHost 注册能力。
7. 使用 ReadOnlyPolicy 限制工具权限。
8. 支持 `list_files`、`read_file`、`search_text` 三个只读工具。
9. 支持 `project-understanding-skill`。
10. 生成 `context.md` 和 `report.md`。

## 验收证据

### 自动化测试

命令：

```bash
npm test
```

结果：

```text
Test Files  15 passed (15)
Tests       25 passed (25)
```

### 类型检查

命令：

```bash
npm run typecheck
```

结果：

```text
tsc -p tsconfig.json --noEmit
exit code 0
```

### 构建

命令：

```bash
npm run build
```

结果：

```text
tsc -p tsconfig.json
exit code 0
```

### 安全扫描

命令：

```bash
rg -n "MINIMAX_API_KEY=.*[A-Za-z0-9_\\-]{16,}|sk-[A-Za-z0-9_\\-]{16,}" . --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json'
```

结果：

```text
无命中
```

### CLI Smoke

命令：

```bash
printf "/help\n/exit\n" | npm run dev
```

结果：

```text
Figo Agent V1 已启动
展示中文帮助
会话已结束
```

命令：

```bash
printf "理解当前项目\n/exit\n" | npm run dev
```

结果：

```text
项目理解完成
输出 context.md 路径
输出 report.md 路径
会话已结束
```

## 数据与产物

V1 运行后生成：

```text
.figo-agent/figo-agent.db
.figo-agent/artifacts/sessions/<session-id>/trace.jsonl
.figo-agent/artifacts/sessions/<session-id>/<turn-id>/context.md
.figo-agent/artifacts/sessions/<session-id>/<turn-id>/report.md
```

状态源：

1. SQLite 是业务状态源。
2. JSONL 是审计流水。
3. Markdown 是阅读产物。

## Git 收口状态

主仓库存在以下变更：

1. `AGENTS.MD`
2. `readme.md`
3. `package.json`
4. `package-lock.json`
5. `.gitignore`
6. `.npmrc`
7. `src/`
8. `tests/`
9. `docs/superpowers/plans/2026-10-10-v1-cli-harness.md`
10. `docs/agent/modules/storage/IMPLEMENTATION.md`
11. `docs/agent/runs/2026-10-11-v1-cli-harness-acceptance.md`

Submodule `figo-wiki` 存在脱敏变更：

1. 10 个 JSON 文件中的 `key` / `apiKey` 字段已替换为 `<REDACTED_API_KEY>`。
2. 该变更用于让全仓库密钥扫描通过。
3. `figo-wiki` 是独立 Git submodule，提交时需要进入 submodule 单独提交，再回主仓库更新 submodule 指针。

## 已知限制

1. V1 不实现 Goal。
2. V1 不实现 `apply_patch`。
3. V1 不实现 `run_command`。
4. V1 不实现 Git 工具。
5. V1 不实现浏览器工具。
6. V1 不实现外部 API 工具。
7. V1 不实现 Verifier。
8. V1 不实现动态插件加载。
9. V1 不实现 TokenUsage 精确入库。
10. V1 不自动写 Memory。
11. Node `node:sqlite` 在 Node 22 下会输出 ExperimentalWarning。

## 本地 MiniMax 配置说明

真实 MiniMax Key 只允许写入本机 `.env` 或当前 shell 环境变量。

推荐方式：

```bash
cp .env.example .env
```

然后在 `.env` 中填写：

```text
MINIMAX_API_KEY=<local secret>
MINIMAX_BASE_URL=https://api.minimaxi.com/v1
MINIMAX_MODEL=MiniMax-M3
```

`.env.example` 不能写真实 key。`.env` 已被 `.gitignore` 排除。

## 下一步建议

### 封版动作

1. Review 主仓库 diff。
2. Review `figo-wiki` submodule 脱敏 diff。
3. 在 `figo-wiki` 内提交脱敏变更。
4. 在主仓库提交 V1 CLI Harness。

### V1.1 候选

1. 增加 Trace 查询命令。
2. 增加最近 report/context 快捷查看。
3. 优化 CLI 输出格式。
4. 增加 SQLite 连接关闭和并发运行保护。

### V2 候选

1. 引入 Goal。
2. 增加 `apply_patch`。
3. 增加 `run_command`。
4. 增加 Verifier。
5. 增加 TokenUsage。
6. 增加 Memory 写入确认流程。
