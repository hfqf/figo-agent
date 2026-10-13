# 运行证据

> 当前版本：v1.0.0
> 最后更新：2026-10-13
> 代码依据：code/src/ui/local-api.ts；code/src/ui/workspace-query-service.ts；code/src/llm/llm-http-capture-store.ts；code/src/token-usage/token-usage-store.ts

按 Turn 查看活动、上下文、HTTP 抓包、Trace、工具记录和 Token。

## 边界与入口

运行证据服务于排查和后续复盘，读取的是执行时落库的事实；它不参与模型流程控制。

入口：Task 活动流、Turn 分析侧栏、Debug Console。

- RunCoordinator 发布 accepted/running/completed 等事件与回答增量；页面通过 SSE 游标回放和订阅后续事件。
- 每次模型调用的请求与响应保存在 llm_http_captures，TokenUsageStore 从响应 usage 读取数值并标识 complete、partial 或 unavailable。
- WorkspaceQueryService 按 Turn 查询 ContextPack、抓包、Trace 和工具调用，在返回 UI 前做密钥与工作区路径脱敏。原始抓包仍保留在 SQLite 中供本地排查。

## 关键字段

- event.seq：SSE 游标
- runId/turnId：执行关联键
- capture.requestId/purpose：模型请求身份
- usage.status：complete/partial/unavailable
- trace.type/source/payload：事件证据

## 接口与服务

- GET /api/v1/events
- GET /api/v1/tasks/:id/activity
- GET /api/v1/tasks/:id/usage
- GET /api/v1/turns/:id/context|captures|trace|tools

## 错误出口

- 不存在的 Turn：HTTP 404
- SSE 游标无效：HTTP 400；连接数超限：HTTP 429
- 上游不返回 usage：标记 unavailable，不伪造 Token 值

## 代码依据

- [`code/src/ui/local-api.ts`](../../../code/src/ui/local-api.ts)
- [`code/src/ui/workspace-query-service.ts`](../../../code/src/ui/workspace-query-service.ts)
- [`code/src/llm/llm-http-capture-store.ts`](../../../code/src/llm/llm-http-capture-store.ts)
- [`code/src/token-usage/token-usage-store.ts`](../../../code/src/token-usage/token-usage-store.ts)

## 流程图

### 运行证据总览

[源图](diagrams/01-overview.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/local-api.ts; code/src/ui/workspace-query-service.ts; code/src/ui/ui-event-store.ts
flowchart TD
  A["选中 Task 和 Turn<br/>工作台活动流"] --> B["GET /api/v1/tasks/:id/activity<br/>或 SSE /api/v1/events"]
  B --> C["展示运行状态、工具轮次和回答增量"]
  C --> R2["引用子流程 02<br/>上下文、抓包、Trace 和 Token<br/>点击查看"]
  R2 --> D["按 turnId 回溯请求、返回和来源<br/>敏感内容在 UI 查询层脱敏"]
  click R2 call openDiagram_02_inspect() "查看运行证据"
  class A,C page;
  class B,D service;
  class R2 ref;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef ref fill:#e8fff3,stroke:#159957,color:#0b5132,stroke-width:2px;
```

### 按 Turn 检查证据

[源图](diagrams/02-inspect.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/workspace-query-service.ts; code/src/llm/llm-http-capture-store.ts; code/src/token-usage/token-usage-store.ts
flowchart TD
  A["点击 Turn 分析页签"] --> B{"选择视图"}
  B -->|上下文| C["GET /api/v1/turns/:id/context<br/>ContextPack、item、checkpoint"]
  B -->|抓包| D["GET /api/v1/turns/:id/captures<br/>请求、响应、模型、耗时"]
  B -->|Trace| E["GET /api/v1/turns/:id/trace<br/>事件类型、来源、时间"]
  B -->|工具| F["GET /api/v1/turns/:id/tools<br/>输入、结果、状态"]
  D --> G["TokenUsageStore<br/>解析 provider usage 字段"]
  G --> H["GET /api/v1/tasks/:id/usage<br/>complete/partial/unavailable"]
  C --> I["WorkspaceQueryService.redactForUi<br/>输出给工作台"]
  D --> I
  E --> I
  F --> I
  B -->|Turn 不存在| X["HTTP 404<br/>不返回分析数据"]
  class A,H page;
  class B decision;
  class C,D,E,F,G,I service;
  class X error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

## 版本记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 运行证据 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-inspect | `code/src/ui/local-api.ts`、`code/src/ui/workspace-query-service.ts`、`code/src/llm/llm-http-capture-store.ts`、`code/src/token-usage/token-usage-store.ts` | Mermaid 浏览器渲染、点击与源图同步检查 |
