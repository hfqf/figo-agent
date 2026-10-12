# Skill 实施计划

## 目标

实现 V1 内置 `project-understanding-skill`，封装项目理解任务方法。

## 文件

- `src/skill/project-understanding-skill.ts`
- `tests/skill/project-understanding-skill.test.ts`

## 实施步骤

1. 定义 SkillManifest。
2. 实现 match：只匹配用户显式输入的 `/skill project-understanding ...`，普通分析请求返回 skipped。
3. 在模型调用前执行预检，通过 ToolRegistry 调用 `list_files`。
4. 根据列表发现实际存在的根目录 README；存在才调用 `read_file`，并检查每个 ToolResult 状态。
5. 汇总文件列表、README 和关键词检索结果作为模型输入证据；空工作区返回明确失败原因。
6. 返回 SkillRunResult。
7. 写入 `skill_runs`。
8. 记录 `skill.activated`。
9. 成功记录 `skill.completed`。
10. 失败记录 `skill.failed`。

## 依赖

- ToolRegistry。
- ContextPack。
- Skill 预检不依赖 LLMResponse；模型在预检之后生成最终答案。
- TraceRecorder。

## 不做

- 不多 Skill 编排。
- 不自动写 Memory。
- 不直接执行 Tool。
- 不生成最终 Markdown。
