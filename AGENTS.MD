# 飞哥上下文

使用本项目下的 `figo-wiki/知识库/skills/figo-context/SKILL.md` 作为飞哥个人上下文入口。

需要读取更多资料时，从：

- `figo-wiki/AGENTS.MD`
- `figo-wiki/知识库/INDEX.md`
- `figo-wiki/知识库/个人画像/`
- `figo-wiki/知识库/项目精华/`
- `figo-wiki/知识库/AI学习体系/`

按任务路由读取。

## 本项目核心目标

本项目目标是从零搭建一个个人 coding agent，用于研究和掌控 agent harness、上下文工程、工具调用、记忆设计、执行闭环和可复盘机制。

第一版不追求一次性做成完整通用型 coding agent，优先构建一个可观察、可替换、可复盘的本地 agent 框架。

本项目不是单纯交付 coding agent 功能，还承担 agent 架构研究、模块设计拆解、工程经验总结和后续文章写作素材沉淀的职责。

## 已确认设计原则

1. 第一版先做命令行交互模式，不优先做单次任务模式。
2. 第一版核心不是强智能，而是把交互循环、上下文构造、工具调用、事件记录和插件扩展跑通。
3. 第一版暂时不引入 Goal 对象；先使用 `Session + Turn + Trace + PluginHost + AgentLoop` 作为小内核。
4. Goal 属于任务管理层，等需要暂停、恢复、状态追踪、多任务区分和任务级闭环时再引入。
5. 上下文体系和记忆体系第一版必须设计进架构，不能后补。
6. 存储第一版使用 Markdown + SQLite：SQLite 作为状态源，Markdown 作为阅读产物，JSONL 作为审计流水。
7. Session 元数据、Turn、状态、索引、上下文条目、记忆记录和工具调用摘要进入 SQLite。
8. Markdown 只保存人类可读的复盘产物，例如上下文说明、最终报告、稳定记忆和方法论沉淀。
9. 第一版采用小内核架构，内核只保留 agent 运行所必需的最小能力。
10. 参考 Pi 的小内核思想，结合高内聚、低耦合、一切皆插件和 SOLID 原则。
11. LLM、Tool、Context Source、Memory Store、Verifier、Reporter、Policy 都按插件能力设计。
12. 小内核依赖抽象契约，不直接依赖具体模型、具体工具、具体存储或具体报告实现。
13. 本项目采用架构完整、能力渐进的建设原则：第一版实现范围保持克制，但核心抽象、模块边界、数据模型和扩展点必须按长期演进设计。
14. 小内核不是简陋内核；第一版不为了 MVP 牺牲 Context、Memory、Trace、Plugin、Policy 等基础架构。
15. Token 统计能力纳入 V2，用于观察上下文规模、模型调用成本、压缩效果和执行效率。
16. 第一版必须纳入 Skill 插件体系，用于承载可复用的任务流程、领域经验、上下文路由、执行规范和输出模板。
17. V1 做关键链路结构化 Trace，不做完整全链路日志平台；Trace 用于后续排查问题、复盘决策链路，并为持续自优化提供数据基础。
18. 第一版范围遵循架构完整、功能克制：骨架先齐，能力先薄，观测链路完整，自动化程度降低。
19. 架构文档必须把各个子模块单独讲清楚，结合文字说明、流程图、UML、数据流图和可复用经验总结，服务后续文章写作。
20. 每个核心子模块的详细讲解必须放在 `docs/agent/modules/<module-name>/` 独立目录中；总架构文档只做总览、索引和跨模块关系说明。
21. AgentLoop 是 agent harness 的核心模块，必须独立成目录讲清阶段机制、状态机、循环控制、失败处理、Trace 点和 V1/V2 演进边界。
22. Storage、Trace、Reporter 分层明确：Storage 负责落盘，Trace 负责事实事件，Reporter 负责把结构化事实转换为中文 Markdown。
23. Reporter 不创造事实、不篡改 Trace、不作为状态源；`context.md` 解释模型看到了什么，`report.md` 解释 agent 做了什么。
24. PluginHost 是小内核和具体能力之间的隔离层；V1 只做静态注册、生命周期管理和能力索引，不做动态插件加载、插件市场和热插拔。
25. AgentLoop 只能通过 PluginHost / Registry 获取 LLMProvider、ContextSource、Skill、Tool、MemoryStore、Reporter 和 Policy，不能直接依赖具体插件实现。
26. CLI、AgentKernel、AgentLoop 三层边界必须清晰：CLI 负责输入输出，AgentKernel 负责启动装配和 Session/Turn 生命周期，AgentLoop 负责编排单轮 Turn 执行。
27. REPL 普通文本才创建 Turn；`/exit`、`/context`、`/memory`、`/report`、`/help` 属于控制命令，不创建普通 Turn。
28. CLI 只展示摘要、错误和 Artifact 路径；完整细节进入 SQLite、Trace、`context.md`、`report.md` 和 `trace.jsonl`。
29. LLMProvider 和 Policy 必须分离：模型输出是推理结果，PolicyDecision 才是 Tool 是否执行的权限依据。
30. 当前运行态使用 ControlledToolPolicy，补齐本地观察、写文件、开放 shell、Git 写操作、网络、浏览器能力，用于支撑验证闭环；ReadOnlyPolicy 只保留为历史 V1 兼容实现和测试样例。
31. 所有运行时配置统一由 `code/figo-agent.config.json` 控制，包括 LLM、Context、Tool、Tool Calling Loop；开发文档只做记录留存，不能作为程序流程控制来源。
32. `code/figo-agent.config.json` 纳入版本库时所有 `apiKey` 必须为空；本机测试临时填写的真实密钥在提交前必须清空，不能写入源码、文档、TraceEvent、SQLite、JSONL、Markdown Artifact 或测试快照。
33. 每个子模块必须有独立 `IMPLEMENTATION.md` 和 `ACCEPTANCE.md`；验收文档中的测试和禁止放行条件没有全部满足时，不能进入下一阶段。
34. LLM 调用需要保留类似抓包的完整请求和返回，主存储进入 SQLite `llm_http_captures`，用于后续做类似 Wireshark 的大模型交互解析界面。
35. LLM 抓包记录完整 request body、response body、HTTP 状态、headers、耗时和模型信息；Authorization、API Key、token、secret、password 必须脱敏。
36. V1.1 引入 Task 作为上下文边界，结构从 `Session -> Turn -> ContextPack` 升级为 `Session -> Task -> Turn -> ContextPack -> LLMCall`。
37. Task 是上下文组织单元，Goal 是执行管理单元；Task 不做验收闭环，不替代 Goal。
38. Task 生命周期必须闭环：`active`、`paused`、`completed`、`cancelled`、`archived`，并通过 `/task` 命令显式管理。
39. `/task finish` 必须生成 `task-summary.md`，聚合 Turn、LLM Capture、Tool、Artifact 和 Trace 摘要。
40. Turn、ContextPack、LLM Capture、Artifact、TraceEvent 都必须具备 `task_id` 归属，方便后续 Wireshark 风格界面按 Task 展开交互链路。
41. V1.2 必须实现 `run_command`、`write_file`、`apply_patch`、Git、网络和浏览器 Tool；这些能力必须经过 Policy、Trace、超时、输出截断、工作区边界和危险操作拦截。
42. 上下文压缩的触发权属于 agent 内部策略，不属于 LLMProvider；不得按 MiniMax、GPT 等具体模型写死触发流程。压缩策略的运行配置统一放入 `code/figo-agent.config.json`，TokenUsage 只负责观测，不作为压缩功能的前置条件。
43. 压缩检查点单独记录完整 Turn 覆盖范围，摘要只记录实际引用的来源；模型输出先剥离完整思考块，再做 JSON 结构、来源和长度校验。校验失败不得推进检查点，ContextBuilder 必须回退原始历史。
44. SQLite 的时间列统一使用上海本地时间文本 `YYYY-MM-DD HH:mm:ss.SSS`，读取时按上海时间解释；旧数据迁移必须可回滚、不可重复偏移。
45. 上下文压缩的现有阈值作为冷启动默认值；后续自优化由 Agent 内部策略基于可追溯证据、摘要质量门槛和回滚机制分阶段实施。Task 历史与工具轮次策略分开，多模型学习结果独立；TokenUsage 不作为该机制的前置条件。讨论方案见 `docs/agent/modules/context/COMPACTION_SELF_OPTIMIZATION.md`，该文档不控制程序运行。
46. TokenUsage 以单次 LLM 请求为实际用量统计单位，Provider 未返回的用量保持未知，不能用 ContextPack 或消息估算补零或冒充真实值；普通对话与压缩请求统一保留用途、模型和原始抓包引用，不对单个 Tool/Skill 编造实际用量归因。
47. UI 首期采用本地 Web 工作台，视觉参考 `figox/shots/` 的抓包、上下文、Trace 三张效果图；后续桌面端封装必须复用 Web 前端与本地服务协议，不复制 AgentLoop。
48. UI 与 CLI 是同一 Agent 应用层的不同适配器；浏览器不能直接读写 SQLite、运行配置或执行 Tool。页面截图是设计参考，不是运行事实或验收证据；UI 设计见 `docs/agent/modules/ui/design.md`。
49. 文件浏览属于人的只读观察，点击文件不自动进入模型上下文；只有显式引用并经服务端校验与 ContextBuilder 取舍后才成为可追溯的 ContextItem。上下文、抓包、Trace 分别回答“准备了什么”“实际传了什么”“程序做了什么”，不能混用估算与实测，也不能把 Trace 当作模型思维链。

## V1 实施状态

V1 CLI Harness 已按 `docs/superpowers/plans/2026-10-10-v1-cli-harness.md` 落地到代码。

已实现模块：

1. CLI / REPL：`code/src/cli/`。
2. AgentKernel：`code/src/kernel/`。
3. AgentLoop：`code/src/loop/`。
4. PluginHost：`code/src/plugin/`。
5. Storage：`code/src/storage/`。
6. Trace：`code/src/trace/`。
7. LLM / Policy：`code/src/llm/`、`code/src/policy/`。
8. Tool：`code/src/tools/`。
9. Context：`code/src/context/`。
10. Memory：`code/src/memory/`。
11. Skill：`code/src/skill/`。
12. Reporter：`code/src/reporter/`。

V1 运行命令：

```bash
npm --prefix code install
npm --prefix code run dev
```

V1 验收命令：

```bash
npm --prefix code test
npm --prefix code run typecheck
npm --prefix code run build
```

V1 安全规则：

1. 仓库中的 `code/figo-agent.config.json` 只保存空 `apiKey`；本机测试临时填写后，提交前必须清空并检查暂存差异。
2. 源码、文档、TraceEvent、SQLite、JSONL、Markdown Artifact、测试快照都不能写入真实 API Key。
3. 发布前必须运行全仓库密钥扫描。

## 上下文与记忆边界

1. Context 是当前这一轮推理要提供给模型的信息包。
2. Memory 是跨轮、跨会话、跨项目可复用的稳定信息资产。
3. Trace 是本次运行真实发生过的事实流水。
4. Artifact 是给人阅读和复盘的产物。

上下文设计必须保留可解释性。每个上下文条目都要记录来源、内容、进入原因、优先级、预算估算和取舍决策。

上下文设计预留 Token 统计字段。V2 开始由 ContextPack、ContextItem、模型请求、模型响应和工具结果摘要记录可用于统计的 token 估算或实际用量；压缩触发由 agent 自身的策略判断。

第一版上下文链路按以下方向设计：

```text
ContextSource -> ContextItem -> ContextPack -> SQLite -> Markdown Artifact
```

ContextBuilder 不直接绑定具体文件读取逻辑；它通过 ContextSource 插件收集候选项，再由取舍与压缩策略生成 ContextPack。原始 Turn 和 LLM 抓包保留在 SQLite，压缩结果作为可追溯的派生记录。

## Skill 插件体系

第一版 Skill 插件体系用于表达“可复用的智能体能力”，不是简单工具函数。

Skill 和 Tool 的边界：

1. Tool 是原子能力，例如读文件、搜索文本、执行命令、写补丁。
2. Skill 是任务方法，例如项目理解、代码审查、上下文梳理、文档生成、记忆沉淀、故障诊断。
3. Tool 负责执行动作，Skill 负责任务流程、输入约束、上下文选择、输出结构和验收标准。
4. AgentLoop 可以调用 Tool，也可以根据当前 Turn 激活一个或多个 Skill。

第一版 Skill 插件要支持以下能力：

1. 声明触发场景和关键词。
2. 声明需要的上下文来源。
3. 声明可使用的 Tool 能力边界。
4. 声明执行步骤和输出结构。
5. 声明验收标准和失败处理方式。
6. 声明是否需要写入 Memory、Artifact 或 Trace。

第一版 Skill 插件先采用静态注册，不做动态插件市场。架构上保留 SkillRegistry、SkillLoader、SkillRunner 和 SkillManifest 抽象。

Skill 插件必须可观察：每次 Skill 激活、跳过、执行、失败和完成都要写入 TraceEvent，并进入 SQLite 结构化记录。

## 可追踪与自优化原则

本项目 V1 做关键链路结构化 Trace，不做完整全链路日志平台，不能只打印到控制台。

第一版至少追踪以下事件：

1. 用户输入和系统输出。
2. Session 创建、恢复、结束和异常退出。
3. Turn 创建、处理开始、处理结束和失败。
4. ContextPack 构造过程、候选上下文、取舍决策和压缩结果。
5. Memory 检索、命中、跳过、候选写入和确认写入。
6. Skill 激活、跳过、执行步骤、完成和失败。
7. Tool 调用参数摘要、执行结果摘要、错误信息、耗时和退出码。
8. LLM 请求、响应、模型名称、耗时和错误；V2 起记录 token 用量。
9. Policy 判断、权限拦截、用户确认和拒绝。
10. Artifact 生成、路径、类型和来源事件。

Trace 设计要求：

1. TraceEvent 是事实记录，不写空泛总结。
2. 每条 TraceEvent 必须包含时间、类型、来源模块、关联 session、关联 turn 和结构化 payload。
3. SQLite 保存可查询的结构化事件。
4. JSONL 保存完整审计流水。
5. Markdown 报告只从结构化事实生成，不能反过来作为状态源。
6. 错误事件必须保留直接错误信息、触发输入、相关上下文引用和处理结果。
7. 后续持续自优化只能基于 Trace、Token、Memory、Tool、Skill 等结构化事实做分析，不能依赖零散控制台输出。

V1 不实现以下观测能力：

1. OpenTelemetry。
2. Span 嵌套树。
3. 日志可视化 UI。
4. 复杂指标系统。
5. 自动异常归因。
6. 完整全链路日志平台。

## 版本范围

### V1 核心闭环

V1 只实现最小可运行闭环，验证架构骨架。

必须包含：

1. CLI / REPL。
2. Session / Turn。
3. SQLite 状态源。
4. TraceEvent 结构化记录。
5. ContextPack 最小构造。
6. 静态 PluginHost。
7. 最小 Tool 集。
8. 一个内置 Skill。
9. Markdown Report。

V1 最小 Tool 集：

1. `list_files`：列目录。
2. `read_file`：读文件。
3. `search_text`：搜索文本。

V1.2 Tool 补全集：

1. `system_info`：读取固定白名单本机环境信息，包括 OS、arch、CPU 核心数、总内存、Node 版本、工作区路径和当前 shell 名称。
2. `path_stat`：读取工作区内路径元信息，包括是否存在、类型、大小、mtime。
3. `read_many_files`：批量读取工作区内小文件，带单文件大小限制和总字符数限制。
4. `workspace_summary`：汇总工作区目录、package 信息、脚本列表、关键配置文件存在性。
5. `write_file`：写入工作区内文件，支持新建和覆盖。
6. `apply_patch`：应用结构化补丁，保留 patch 内容和结果摘要。
7. `run_command`：在工作区内执行 shell 命令，带 timeout、maxOutputBytes、exitCode 和 stderr/stdout 记录。
8. `git_status`、`git_diff`、`git_log`、`git_add`、`git_commit`：支持 Git 查看和写操作。
9. `network_fetch`：执行受控 HTTP 请求，限制方法、大小和超时。
10. `browser_open`、`browser_snapshot`：支持受控浏览器打开和页面状态读取。

V1.2 风险控制要求：

1. 所有 Tool 必须经过 ControlledToolPolicy。
2. 所有 Tool 调用必须写入 TraceEvent 和 tool_calls。
3. 写文件、命令、Git、网络、浏览器 Tool 必须记录输入摘要、输出摘要、耗时、错误和退出码。
4. `run_command` 必须限制 cwd 在工作区内，必须设置 timeout 和输出截断。
5. Git 写操作必须保留 diff 摘要和 commit message。
6. 网络请求不能携带明文密钥，headers 中的 Authorization、API Key、token、secret、password 必须脱敏。
7. 浏览器 Tool 必须记录 URL 和页面标题，不保存敏感输入。

V1 唯一内置 Skill：

1. `project-understanding-skill`：读取项目规则、README、目录结构和已有记忆，生成项目理解报告。

V1 暂不实现：

1. Goal。
2. `apply_patch`。
3. `run_command`。
4. Git 操作。
5. 浏览器工具。
6. 外部 API 工具。
7. Verifier。
8. 复杂 Policy。
9. 动态插件加载。
10. 多 Skill 编排。
11. 自动 Memory 写入。
12. 持续自优化。

### V2 待做方向

V2 重点从“受控执行开发任务”扩展到“Goal、Verifier 和自优化闭环”。

候选内容：

1. 引入 Goal 对象，支持任务级状态、暂停、恢复和完成报告。
2. 引入 Verifier 插件，支持测试、lint、build 的验证闭环。
3. 完善 Goal 执行管理，支持任务级状态、暂停、恢复和完成报告。
4. 完善 Policy profile，支持不同项目的权限策略切换。
5. 增加 Tool dry-run 和风险评分。
6. 增加 Tool 调用回放和失败归因。
7. 增加 Memory 候选写入和人工确认流程。
8. 增加第二批 Skill，例如代码审查、故障诊断、文档生成、变更总结。
9. 完善 Markdown Artifact，生成任务报告、验证报告和变更报告。
10. TokenUsage 请求级统计已实现：记录 Provider 实际用量、未知状态、上下文估算和 Session/Task/Turn 汇总；价格成本、压缩效果对照仍待做。
11. 继续完善 Token 统计报表；单个 Skill/Tool 的实际用量分摊须先建立可验证的归因口径，不能直接按总量猜测。

### V3 待做方向

V3 重点从“受控执行”扩展到“可持续演进和生态化”。

候选内容：

1. 动态插件加载。
2. Skill 插件目录和本地插件包管理。
3. 多 Skill 编排。
4. 多 Agent 或角色化 Agent。
5. 长期 Memory 治理，包括去重、过期、评分、归档和迁移。
6. 向量检索或混合检索。
7. 持续自优化，根据 Trace、Token、Tool、Skill、错误记录生成改进建议。
8. 已确认的本地 Web UI 后续可封装桌面端；Web 首期按独立 UI 设计和验收路线实施，不以 TUI 作为替代方案。
9. 浏览器工具的交互式审批与能力扩展；基础浏览器 Tool 已在 V1.2 落地。
10. 外部 API / MCP / 知识库连接。
11. 云端任务或远程执行模式。
12. 插件市场或可共享 Skill 生态。

## 架构约束

后续设计和实现必须遵循以下约束：

1. 单一职责：CLI 只负责输入输出，AgentLoop 只负责编排循环，TraceStore 只负责记录轨迹。
2. 开闭原则：新增模型、工具、上下文来源、记忆存储和验证方式通过插件扩展。
3. 依赖倒置：内核依赖 contracts，不依赖具体插件实现。
4. 接口隔离：LLM、Tool、Memory、Context、Verifier、Reporter、Policy 分开定义，避免大而全的 AgentService。
5. 高内聚低耦合：每个模块只处理一个清晰变化点，通过明确接口协作。
6. 文档先行：沟通中确认的架构原则、边界和取舍要及时沉淀到本文档或后续设计文档。
7. 架构完整、能力渐进：功能可以分阶段实现，架构边界不能因为 MVP 写死或弱化。
8. 抽象必须有明确变化来源：模型、工具、上下文来源、记忆存储、权限策略、输出形式都属于明确变化点，可以抽象；无变化来源的抽象不提前引入。
9. Token 统计是 V2 一等观测能力：AgentLoop、ContextBuilder、LLMProvider、TraceStore 和 Reporter 都要围绕 token 使用量提供结构化数据。
10. Skill 插件是一等扩展能力：Skill 负责封装任务方法和领域经验，Tool 负责原子动作，二者不能混成一个概念。
11. 可追踪是一等架构能力：V1 只做关键链路结构化 Trace，关键事件必须写入 TraceEvent，并能从 SQLite、JSONL 和 Markdown 报告中追溯。
12. 版本边界要清晰：V1 验证小内核闭环，V2 增加受控开发执行，V3 增加持续自优化和生态扩展。
13. 架构设计要兼顾实现和表达：每个核心模块都要说明设计动机、职责边界、输入输出、协作关系、失败处理和可沉淀的方法论。
14. 子模块文档独立成目录：每个模块目录至少包含 `README.md`，需要图示时在该目录内保存 Mermaid、SVG、PNG 或 HTML 产物。
15. 模型选择显式化：运行配置可以保存多个模型条目，但只调用 `activeModelId` 指向的已启用条目；配置错误时拒绝启动，不能静默切换到默认模型。模型协议与厂商标识分离，普通调用和压缩调用使用同一选中条目。

## Token 统计原则

V2 Token 统计用于回答以下问题：

1. 当前 Turn 构造了多少 token 的上下文。
2. 每类上下文占用了多少 token，例如规则、对话、项目文档、代码片段、记忆和工具结果。
3. 每次模型请求的输入 token、输出 token、总 token 和模型名称。
4. 上下文压缩、截断、摘要前后的 token 变化。
5. 每个 Session 的累计 token 使用量。
6. 每个插件或上下文来源对 token 消耗的贡献。

Token 统计设计要求：

1. SQLite 保存结构化 token 使用记录。
2. Markdown 报告输出可读的 token 使用摘要。
3. TraceEvent 记录每次模型调用和上下文构造的 token 事实。
4. 估算 token 和模型返回的实际 token 要分字段保存，不能混写。
5. 不同模型的 token 计算方式通过 Tokenizer 或 LLMProvider 插件适配，内核不绑定具体模型分词实现。
