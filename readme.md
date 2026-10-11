# Figo Agent 研究记录

## 项目定位

本项目用于从零搭建一个个人 coding agent，以加深对 agent harness、上下文工程、工具调用、记忆设计和执行闭环的理解。

当前阶段不追求一次性做出完整的通用型 coding agent，而是优先构建一个可观察、可替换、可复盘的本地 agent 框架。核心目标是把 agent 的决策过程、上下文来源、工具调用、验证结果和记忆沉淀都记录清楚。

## 当前进度

目前已经完成初步方向探索，形成以下判断：

1. 第一版应优先实现单 agent CLI harness，而不是过早进入多 agent 架构。
2. 第一版重点不是模型能力本身，而是上下文构造、工具协议、执行循环和可观测性。
3. 记忆不应简单等同于聊天记录或向量库，而应沉淀为结构化的事实、偏好、规则和经验。
4. 项目需要保留文档留痕，用文档规范需求、设计、执行过程、问题和决策。
5. 代码设计应重视 SOLID 原则，避免把 LLM 调用、工具调用、记忆检索、上下文组装和任务执行混在一个大类中。

## 建议的系统分层

```text
用户目标
  ↓
Agent Harness 控制循环
  ↓
任务理解 / 计划 / 执行 / 反思
  ↓
上下文工程层
  ↓
工具层：读文件、搜索、编辑、运行测试、Git、浏览器
  ↓
记忆层：短期上下文、项目记忆、长期偏好、经验沉淀
  ↓
可观测性：日志、轨迹、决策记录、评估
```

## 建议的 MVP 范围

第一阶段建议实现一个本地 CLI coding agent，具备以下能力：

1. 读取项目目录结构。
2. 读取关键文档，例如 `README`、`AGENTS.md`、设计文档。
3. 根据用户目标生成中文执行计划。
4. 支持基础工具调用，例如文件读取、文本搜索、命令执行。
5. 输出本次执行报告，记录读取了什么、判断了什么、下一步建议是什么。

暂不建议第一版直接自动修改代码。可以先把“观察、分析、计划、记录”链路做扎实，再逐步加入补丁编辑和验证能力。

## 后续演进路线

### 阶段 1：CLI Harness

实现命令行入口，支持用户输入任务，agent 能够读取项目上下文并生成计划。

重点研究：

- agent loop
- 上下文组装
- token 预算
- 工具协议
- 执行轨迹记录

### 阶段 2：Patch Agent

加入代码修改能力，例如通过 `apply_patch` 或等价机制生成受控补丁。

重点研究：

- 文件编辑安全边界
- diff 审查
- 变更最小化
- 修改前计划与修改后总结

### 阶段 3：Verifier Agent

加入测试、lint、构建等验证能力。

重点研究：

- 反馈闭环
- 失败诊断
- 修改后的自动复查
- “完成”的证据标准

### 阶段 4：Memory Agent

引入项目记忆、用户偏好、任务轨迹摘要和经验沉淀。

建议将记忆分为：

```text
Working Memory   当前任务上下文，随任务结束清理
Project Memory   项目结构、命令、架构约定、技术决策
User Memory      用户偏好，例如中文文档、SOLID、注释风格
Episodic Memory  历史任务轨迹、问题、解决方案和经验
```

重点研究：

- 什么时候写入记忆
- 谁来判断记忆是否值得保存
- 如何避免长期记忆污染当前任务
- 如何基于当前目标检索相关记忆

### 阶段 5：Multi-Agent

在单 agent 的上下文、工具和记忆机制稳定后，再考虑拆分多个角色。

候选角色：

```text
Planner   负责拆解任务和制定计划
Coder     负责实现代码
Reviewer  负责代码审查
Verifier  负责运行验证
Memory    负责沉淀经验
```

不建议过早进入多 agent。多 agent 会增加通信、状态同步、责任边界和调试复杂度，容易掩盖上下文工程本身的问题。

## 关键设计问题

后续需要重点回答以下问题：

1. 什么信息应该进入上下文，什么信息不应该进入？
2. 上下文包如何在 token 预算内保持高信噪比？
3. 工具调用失败时，agent 如何判断是工具问题、模型问题、上下文问题，还是用户目标不清？
4. 记忆应该以什么结构保存，如何更新，如何过期？
5. 项目级记忆和用户级记忆如何分离？
6. 执行轨迹如何记录，才能支持后续复盘和评估？
7. 如何设计接口，保证 LLM、工具、记忆、上下文构建器都可以替换？
8. 如何定义一次任务“完成”的证据？

## 初步技术建议

候选技术栈：

```text
TypeScript / Node.js
  用于 CLI、工具协议、文件系统操作和后续 Web UI。

SQLite
  用于保存任务记录、执行轨迹、结构化记忆和评估数据。

结构化 JSON 记忆
  第一版先不急于引入向量库，优先使用结构化数据和关键词检索。

统一 LLMClient
  将不同模型供应商封装在统一接口后面，避免业务逻辑绑定具体模型。
```

建议核心接口：

```ts
interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}

interface MemoryStore {
  search(query: string): Promise<Memory[]>;
  save(memory: Memory): Promise<void>;
}

interface ContextBuilder {
  build(goal: UserGoal, state: AgentState): Promise<PromptContext>;
}
```

## 文档留痕建议

后续可考虑增加以下目录：

```text
docs/agent/
  context.md              项目理解和当前上下文摘要
  decisions.md            架构决策记录
  tasks.md                任务拆解与状态
  memory.md               项目级记忆
  runs/
    YYYY-MM-DD-xxx.md     单次执行轨迹
```

每次重要探索或实现后，都应补充文档，记录：

1. 本次目标。
2. 使用的上下文。
3. 做出的关键判断。
4. 修改或产出的内容。
5. 遇到的问题。
6. 下一步建议。

## 当前待办

1. 明确第一版 CLI harness 的最小能力边界。
2. 设计核心接口和模块边界。
3. 决定技术栈和目录结构。
4. 建立文档目录和任务记录规范。
5. 设计第一版上下文包格式。
6. 设计第一版记忆数据结构。
7. 决定是否引入 OpenSpec 或类似机制管理需求变更。

## 当前状态

V1 CLI Harness 已进入可运行实现阶段。

当前已具备：

1. CLI / REPL。
2. Session / Turn 生命周期。
3. SQLite 状态源。
4. TraceEvent 结构化记录与 JSONL 审计流水。
5. ContextPack 构造，默认包含当前 Turn、当前 Task 历史、Memory，不默认读取开发文档。
6. 静态 PluginHost。
7. ControlledToolPolicy。
8. 受控 Tool：只读、本机信息、写文件、命令、Git、网络、浏览器。
9. `project-understanding-skill`。
10. `context.md` 和 `report.md` Markdown 阅读产物。
11. `figo-agent.config.json` 统一运行时配置。

## V1 本地运行

安装依赖：

```bash
npm install
```

启动 REPL：

```bash
npm run dev
```

直接编辑项目根目录的本机 `figo-agent.config.json`；新环境需先创建此文件，配置结构见 [LLM / Policy 模块设计](docs/agent/modules/llm-policy/README.md)。在目标 `llm` 条目填写 `apiKey`，将 `enabled` 设为 `true`，并把顶层 `activeModelId` 设为其 `id`。修改配置后重启 CLI 生效。该文件包含密钥，已被 `.gitignore` 排除，不提交到版本库。

运行时控制项全部来自 `figo-agent.config.json`：

1. `llm`：模型数组；每项声明 `id`、`enabled`、协议、密钥、地址与模型名。`activeModelId` 显式选择当前模型。
2. `context`：是否纳入项目文档、项目文档路径、Task 历史轮数、Memory 开关。
3. `tools`：工具调用轮次上限、允许注册的 Tool 清单。

`AGENTS.MD`、`readme.md` 和 `docs/**` 是研发记录，不参与默认流程控制。只有 `context.includeProjectDocs=true` 时，配置声明的项目文档才进入模型上下文。

V1 支持命令：

```text
/exit
/context
/memory
/report
/help
```

普通文本会创建一个 Turn，例如：

```bash
printf "理解当前项目\n/exit\n" | npm run dev
```

V1 会在工作区生成 `.figo-agent/`：

```text
.figo-agent/figo-agent.db
.figo-agent/artifacts/sessions/<session-id>/trace.jsonl
.figo-agent/artifacts/sessions/<session-id>/<turn-id>/context.md
.figo-agent/artifacts/sessions/<session-id>/<turn-id>/report.md
```

SQLite 是状态源，Markdown 是阅读产物，JSONL 是审计流水。

## V1 验收命令

```bash
npm test
npm run typecheck
npm run build
rg -n "sk-[A-Za-z0-9_\\-]{16,}" . --glob '!node_modules/**' --glob '!dist/**' --glob '!package-lock.json' --glob '!figo-agent.config.json'
```

放行规则：测试、类型检查、构建和密钥扫描全部通过才允许放行。
