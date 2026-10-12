# 项目分析误报完成：Session 证据与修复

## 现象与范围

工作区为 `/Users/points/Documents/gitee1/figo-aistudy`，Session 为 `ses_3ac8bbe5-f048-494e-b93c-e28f72defa3e`。两次普通提问“分析下当前项目”“分析当前项目”最终都显示“项目理解完成：已读取项目文件列表、README，并完成关键词检索。”实际磁盘根目录没有 README，也没有可分析的项目文件；除 Agent 生成的 `.figo-agent` 外，仅有空的“知识库”目录。

## 直接证据

| 环节 | SQLite / 抓包事实 |
| :--- | :--- |
| 第一次 Turn `turn_d340c9c1...` | `list_files` 返回 `{"files":[]}`；`read_file` 输入 `{"path":"readme.md"}`，报 `ENOENT`；`search_text` 返回空结果。 |
| 第一次模型返回 | `gpt-5.6-sol` 的 HTTP 抓包响应明确说“未能分析当前项目：我没有获取到工作区文件摘要”。 |
| 第二次 Turn `turn_07c46b25...` | 模型主动调用 `workspace_summary`、`git_status`、`list_files`；文件列表仍为空，Git 返回“not a git repository”。 |
| 第二次模型最终返回 | 模型明确说明当前工作区没有项目文件，无法可靠判断技术栈、模块、启动方式或风险。 |
| 两次落库最终输出 | `turns.output` 均被替换为同一条固定“项目理解完成”文案，第二次 Run 已完成，不是仍在后台等待模型。 |

## 根因

1. `ProjectUnderstandingSkill.canHandle()` 用“分析.*项目”等自然语言正则自动匹配普通 Turn；用户没有显式请求 Skill。
2. Skill 固定调用 `read_file("readme.md")`，没有先确认该文件存在；`ToolRegistry.execute()` 以 `ToolResult.status="failed"` 返回错误，而不是抛异常，Skill 未检查状态，仍把 `skill_runs.status` 标成 `completed`。
3. `AgentLoop` 在模型返回后再运行 Skill，并以 Skill 的固定完成消息覆盖 `LLMResponse.content`，同时写入 Turn 输出和 `report.md`。因此抓包中的正确模型结论没有进入最终交互。

## 修复边界

- 普通任务只走 ContextPack、LLM 和有界 Tool Calling Loop；只有用户显式输入 `/skill project-understanding ...` 才运行项目理解 Skill。CLI 将该指令路由为 Turn，Web 输入框原样提交。
- 显式 Skill 在模型调用前做证据预检：先列文件；空目录返回明确失败原因；存在根目录 README 才按真实文件名读取；每个 ToolResult 必须检查状态。
- Skill 结果作为模型输入证据，最终答复与 Markdown 报告只使用模型基于实际工具结果形成的内容，不以 Skill 状态文案覆盖。
- 回归覆盖普通 Turn 不创建 SkillRun、空目录不调用 `read_file`、实际 README 文件名读取、模型回复原样保留、CLI 显式指令可达。

## 工程经验

Tool 的失败是**返回值语义**，不能只靠 `try/catch` 判断执行成功。Skill 的 `completed` 表示流程执行状态，不代表用户目标完成；模型抓包与 `turns.output` 必须可对账。隐式关键词激活会改变用户请求的执行协议，必须由明确指令或可审计授权控制。修复不重写历史 Session、Turn、抓包或报告，旧记录保留用于复盘。

## 修复后真实模型验收

重启本地工作台后，在同一空工作区提交普通输入“分析当前项目”，产生 Turn `turn_068fd871-b6ee-4dc7-b1b2-d603122fc17c`。真实 `gpt-5.6-sol` 调用完成，模型先请求 `workspace_summary`，返回文件列表为空；第二次模型响应以 `FINAL` 给出“当前未发现可供分析的文件，因此无法判断项目技术栈、结构或功能”的明确结论。SQLite 验证：该 Turn 的 `skill_runs=0`、`read_file` 调用数为 `0`、`skill.skipped` 为 `1`；`turns.output` 保存模型结论。浏览器 API 会把绝对工作区路径脱敏为 `.`，原始落库答复仍保存真实路径。此验收只证明本次空工作区行为，不把它表述为已完成项目代码分析。
