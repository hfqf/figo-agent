# Agent 子模块架构讲解索引

代码与配置位于仓库根目录的 `code/`。本文档体系中的 `src/`、`tests/`、`package.json` 和 npm 命令均以 `code/` 为工作目录；`.figo-agent/` 运行数据仍位于仓库根目录。

## 文档索引信息

- 背景：本文档位于 `docs/agent/modules/`，用于管理 Figo Agent 各阶段子模块的独立架构讲解。
- 目标：把核心模块拆成独立目录，便于逐个讲清设计动机、职责边界、流程、UML 和工程经验。
- 标签：agent harness、模块设计、架构拆解、文章素材、SOLID。
- 适用范围：V1 及后续子模块设计、实现计划、文章拆稿、模块复盘。
- 后续可用方向：逐个补充模块流程图、UML、数据流图、失败处理和方法论总结。

## 模块目录

| 模块 | 目录 | 状态 | 讲解重点 |
| :--- | :--- | :--- | :--- |
| CLI / REPL | [cli-repl](./cli-repl/) | 已完成 | 命令行入口、交互边界、用户输入如何进入 Turn |
| Task | [task](./task/) | V1.1 已实现 | 任务级上下文边界、生命周期、Task Summary、抓包界面树 |
| Agent Kernel | [agent-kernel](./agent-kernel/) | 已完成 | 小内核、Session、Turn、启动装配、TraceRecorder |
| AgentLoop | [agent-loop](./agent-loop/) | 已完成 | 核心控制循环、阶段机制、状态机、Skill / Tool / LLM 协作 |
| PluginHost | [plugin-host](./plugin-host/) | 已完成 | 静态插件注册、能力发现、插件生命周期 |
| Context | [context](./context/) | 已完成 | ContextSource、ContextItem、ContextPack、取舍决策 |
| Memory | [memory](./memory/) | 已完成 | MemoryRecord、项目记忆、用户记忆、Markdown + SQLite |
| Skill | [skill](./skill/) | 已完成 | SkillManifest、SkillRunner、任务方法和领域经验封装 |
| Tool | [tool](./tool/) | V1.2 已实现 | 原子工具、结构化输入输出、受控执行 Tool、权限边界 |
| Trace | [trace](./trace/) | 已完成 | 关键链路结构化 Trace、SQLite、JSONL、排查与复盘 |
| Storage | [storage](./storage/) | 已完成 | SQLite 状态源、Artifact、目录结构、schema 边界 |
| Reporter | [reporter](./reporter/) | 已完成 | Markdown 报告、context.md、report.md、事实到表达 |
| LLM / Policy | [llm-policy](./llm-policy/) | 当前受控策略已实现 | LLMProvider、模型选择、ControlledToolPolicy、运行安全边界 |
| TokenUsage | [token-usage](./token-usage/) | V2 请求级统计已实现 | 实际 usage 入库与旧抓包回填、上下文估算、CLI/报告汇总 |
| 本地 Web UI | [ui/design.md](./ui/design.md) | 首期本地 Web 已实现并自测 | 工作台、文件浏览、上下文/抓包/Trace 检查器、运行协议与验收 |

## 完成状态

V1 架构设计阶段的 13 个子模块已经完成独立说明。V1.1 增加 Task 子模块，用于补齐多轮上下文边界。后续 TokenUsage 与本地 Web UI 首期已实施；UI 的增强能力和桌面封装仍待开发。以下统一结构适用于原有模块的架构说明；UI 目录按 `design.md`、工作台、检查器、运行协议与验收专题拆分：

1. 模块定位。
2. 设计动机。
3. 职责边界。
4. 输入输出。
5. 流程图。
6. UML / 类图。
7. 失败处理。
8. V1 实现范围。
9. V2/V3 扩展点。
10. 可沉淀的文章观点。

## 统一写作结构

每个子模块目录的 `README.md` 必须按以下结构展开：

1. 文档索引信息。
2. 模块定位。
3. 设计动机。
4. 职责边界。
5. 输入输出。
6. 核心数据结构。
7. 运行流程图。
8. UML / 类图。
9. 与其他模块的协作关系。
10. 失败处理。
11. V1 实现范围。
12. V2/V3 扩展点。
13. 可沉淀的文章观点。

## 图示管理规则

1. Mermaid 图可以直接写在模块 `README.md` 中。
2. SVG、PNG、HTML 图示产物放在模块目录下的 `assets/` 中。
3. 每张图必须服务架构表达，不做装饰图。
4. 图示要能解释模块边界、数据流、生命周期或依赖关系。
