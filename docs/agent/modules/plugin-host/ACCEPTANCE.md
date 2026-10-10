# PluginHost 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/plugin/plugin-host.test.ts
npm run typecheck
```

## 必须通过

1. 可以注册静态插件。
2. 重复 plugin id 启动失败。
3. 重复 capability name 启动失败。
4. setup 后可查询 Tool 能力。
5. setup 后可查询 Skill 能力。
6. setup 后可查询 LLMProvider。
7. setup 后可查询 Policy。
8. 必需能力缺失时不进入 REPL。

## Trace 验收

`trace_events` 中包含：

```text
plugin.registered
plugin.ready
capability.registered
```

## 禁止放行条件

1. AgentLoop 直接 new 具体插件。
2. PluginHost 执行 Tool。
3. PluginHost 决定 ContextPack 取舍。
4. PluginHost 包含动态加载逻辑。
