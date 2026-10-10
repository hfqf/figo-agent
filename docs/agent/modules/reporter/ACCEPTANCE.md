# Reporter 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/reporter/markdown-reporter.test.ts
npm run typecheck
```

## 必须通过

1. 生成 `context.md`。
2. 生成 `report.md`。
3. `context.md` 包含 ContextPack id。
4. `context.md` 包含 included items。
5. `report.md` 包含用户输入。
6. `report.md` 包含执行摘要。
7. Artifact 元数据进入 `artifacts`。
8. Markdown 内容为中文。

## Trace 验收

必须支持：

```text
artifact.created
```

## 禁止放行条件

1. Reporter 编造结构化事实。
2. Reporter 修改 TraceEvent。
3. Reporter 调用 Tool。
4. Reporter 调用 LLM 润色报告。
