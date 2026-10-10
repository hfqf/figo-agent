# Skill 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/skill/project-understanding-skill.test.ts
npm run typecheck
```

## 必须通过

1. 项目理解类输入能匹配 Skill。
2. 非项目理解类输入能返回 skipped。
3. Skill 通过 ToolRegistry 调用 Tool。
4. Skill 不直接执行 Tool。
5. SkillRun 写入 `skill_runs`。
6. Skill 成功返回中文摘要。

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
