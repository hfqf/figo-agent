# Reporter 实施计划

## 目标

实现 MarkdownReporter，把结构化事实转换为 `context.md` 和 `report.md`。

## 文件

- `src/reporter/markdown-reporter.ts`
- `tests/reporter/markdown-reporter.test.ts`

## 实施步骤

1. 实现 `writeContext(contextPack)`。
2. `context.md` 包含 ContextPack 基本信息。
3. `context.md` 包含 included items。
4. 实现 `writeReport(input)`。
5. `report.md` 包含 Session、Turn、执行摘要、上下文来源、Artifact。
6. Markdown 使用中文。
7. 通过 StorageManager 写 Artifact。
8. Artifact 元数据写入 `artifacts`。
9. Artifact 创建写入 `artifact.created`。

## 依赖

- StorageManager。
- TraceRecorder。
- ContextPack。
- TurnResult。

## 不做

- 不调用 LLM 润色。
- 不保存 Markdown 全文到 SQLite。
- 不篡改 Trace。
- 不生成 HTML 或 PDF。
