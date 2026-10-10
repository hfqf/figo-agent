# Trace 实施计划

## 目标

实现结构化 TraceEvent 写入 SQLite 和 `trace.jsonl`，为排查、复盘和报告提供事实流水。

## 文件

- `src/trace/trace-recorder.ts`
- `tests/trace/trace-recorder.test.ts`

## 实施步骤

1. 定义 TraceEventInput。
2. 实现 `TraceRecorder.record(input)`。
3. 自动生成 event id。
4. 自动生成 createdAt。
5. payload 做基础脱敏。
6. 写入 SQLite `trace_events`。
7. 追加写入 `.figo-agent/artifacts/sessions/<session-id>/trace.jsonl`。
8. 写入失败返回结构化错误。

## 依赖

- StorageManager。
- TraceEventType。

## 不做

- 不做 OpenTelemetry。
- 不做 Span。
- 不做 Trace UI。
- 不保存完整 prompt。
- 不保存 API Key。
