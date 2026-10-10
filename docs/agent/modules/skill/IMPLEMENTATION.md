# Skill 实施计划

## 目标

实现 V1 内置 `project-understanding-skill`，封装项目理解任务方法。

## 文件

- `src/skill/project-understanding-skill.ts`
- `tests/skill/project-understanding-skill.test.ts`

## 实施步骤

1. 定义 SkillManifest。
2. 实现 match：匹配项目理解、架构梳理、分析类输入。
3. 实现 run：读取 ContextPack 和 LLMResponse。
4. 通过 ToolRegistry 调用 `list_files`。
5. 汇总项目理解消息。
6. 返回 SkillRunResult。
7. 写入 `skill_runs`。
8. 记录 `skill.activated`。
9. 成功记录 `skill.completed`。
10. 失败记录 `skill.failed`。

## 依赖

- ToolRegistry。
- ContextPack。
- LLMResponse。
- TraceRecorder。

## 不做

- 不多 Skill 编排。
- 不自动写 Memory。
- 不直接执行 Tool。
- 不生成最终 Markdown。
