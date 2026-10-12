# Skill 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/skill/project-understanding-skill.test.ts
npm run typecheck
```

## 必须通过

1. 普通“分析当前项目”不能自动匹配 Skill；只有 `/skill project-understanding ...` 能激活。
2. 未显式指定 Skill 的输入返回 skipped，不执行 Skill Tool。
3. Skill 通过 ToolRegistry 调用 Tool。
4. Skill 不直接执行 Tool。
5. SkillRun 写入 `skill_runs`。
6. Skill 成功返回基于真实文件的中文预检证据，不替代模型最终回答。
7. 空工作区不调用 `read_file`，不声称读取 README，返回明确失败原因。
8. 存在 README 时按实际文件名读取；ToolResult 失败不能计作成功。

## Trace 验收

必须支持：

```text
skill.activated
skill.skipped
skill.completed
skill.failed
```

## 禁止放行条件

1. Skill 绕过 ToolRegistry。
2. Skill 绕过 Policy。
3. Skill 直接写 Markdown。
4. V1 同时激活多个 Skill。
5. Skill 固定完成文案覆盖模型答复或报告。

## 2026-10-12 回归记录

`project-understanding-skill.test.ts` 覆盖显式触发、普通分析不触发、空目录不读取 README、按实际文件名读取 `README.md`；`project-understanding.test.ts` 覆盖显式 Skill 只提供模型证据、普通 Turn 不新增 SkillRun、报告保留模型答复。全量 `npm test` 为 48 个文件、151 项测试通过，`npm run typecheck`、`npm run build`、`npm run web:test:e2e` 通过。真实模型空工作区验证及历史故障证据见 [事件复盘](../agent-loop/INCIDENT_2026-10-12_PROJECT_ANALYSIS.md)。
