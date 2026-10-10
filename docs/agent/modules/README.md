# V1 子模块架构讲解索引

## 文档索引信息

- 背景：本文档位于 `docs/agent/modules/`，用于管理 Figo Agent V1 各子模块的独立架构讲解。
- 目标：把 V1 核心模块拆成独立目录，便于逐个讲清设计动机、职责边界、流程、UML 和工程经验。
- 标签：agent harness、模块设计、架构拆解、文章素材、SOLID。
- 适用范围：V1 子模块设计、后续实现计划、文章拆稿、模块复盘。
- 后续可用方向：逐个补充模块流程图、UML、数据流图、失败处理和方法论总结。

## 模块目录

| 模块 | 目录 | 状态 | 讲解重点 |
| :--- | :--- | :--- | :--- |
| CLI / REPL | [cli-repl](./cli-repl/) | 已完成 | 命令行入口、交互边界、用户输入如何进入 Turn |
| Agent Kernel | [agent-kernel](./agent-kernel/) | 已完成 | 小内核、Session、Turn、启动装配、TraceRecorder |
| AgentLoop | [agent-loop](./agent-loop/) | 已完成 | 核心控制循环、阶段机制、状态机、Skill / Tool / LLM 协作 |
| PluginHost | [plugin-host](./plugin-host/) | 已完成 | 静态插件注册、能力发现、插件生命周期 |
| Context | [context](./context/) | 已完成 | ContextSource、ContextItem、ContextPack、取舍决策 |
| Memory | [memory](./memory/) | 已完成 | MemoryRecord、项目记忆、用户记忆、Markdown + SQLite |
| Skill | [skill](./skill/) | 已完成 | SkillManifest、SkillRunner、任务方法和领域经验封装 |
| Tool | [tool](./tool/) | 已完成 | 原子工具、结构化输入输出、最小 Tool 集 |
| Trace | [trace](./trace/) | 已完成 | 关键链路结构化 Trace、SQLite、JSONL、排查与复盘 |
| Storage | [storage](./storage/) | 已完成 | SQLite 状态源、Artifact、目录结构、schema 边界 |
| Reporter | [reporter](./reporter/) | 已完成 | Markdown 报告、context.md、report.md、事实到表达 |
| LLM / Policy | [llm-policy](./llm-policy/) | 已完成 | LLMProvider、只读策略、V1 安全边界 |
| TokenUsage | [token-usage](./token-usage/) | 已完成 | V1 token 估算、V2 token 统计、成本控制方法 |

## 完成状态

V1 架构设计阶段的 13 个子模块已经完成独立说明。每个模块均包含：

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
