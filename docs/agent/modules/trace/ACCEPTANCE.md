# Trace 测试验收

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/trace/trace-recorder.test.ts
npm run typecheck
```

## 必须通过

1. TraceEvent 写入 `trace_events`。
2. TraceEvent 追加写入 `trace.jsonl`。
3. JSONL 每行可以独立解析。
4. payload 中 `apiKey`、`token`、`secret`、`password` 被脱敏。
5. `sessionId`、`type`、`source` 必填。
6. 事件顺序与记录顺序一致。

## 事件验收

必须支持：

```text
session.started
turn.received
turn.processing
context.build.completed
llm.called
llm.completed
policy.evaluated
policy.denied
tool.denied
tool.completed
skill.completed
artifact.created
turn.completed
error.occurred
```

## 禁止放行条件

1. Trace payload 出现明文 API Key。
2. Trace 只打印到控制台。
3. TraceEvent 不是结构化 JSON。
4. `trace.jsonl` 不能按行解析。
