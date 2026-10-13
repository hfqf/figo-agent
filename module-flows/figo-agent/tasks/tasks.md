# Task 与 Agent 执行

> 当前版本：v1.0.0
> 最后更新：2026-10-13
> 代码依据：code/src/task/task-manager.ts；code/src/ui/run-coordinator.ts；code/src/loop/agent-loop.ts；code/src/ui/local-api.ts；code/src/cli/input-router.ts

创建任务、管理生命周期、提交 Turn，并运行工具调用循环。

## 边界与入口

Task 拥有对话边界和生命周期，Run 拥有异步执行状态；两者不能与模型连接或 UI 面板混为一个模块。

入口：Task 列表、固定输入框、CLI/REPL、活动流。

- Session 下可有多个 Task，当前选中的 Task 记录在 sessions.current_task_id。状态包括 active、paused、completed 和 cancelled；历史 Session 的 Task 在工作台只读。
- 发送消息提交 clientRequestId。RunCoordinator 在事务中创建 Turn 和 ui_runs，再异步运行 AgentLoop；相同幂等键返回原 Run，不并发执行第二个 Run。
- AgentLoop 先构造上下文并选模型，然后在有工具调用时顺序执行工具、追加结果、再次调用模型，直到最终回答或达到轮次上限。
- CLI 入口通过 routeInput 将普通文本送入 submitTurn，将 /task、/compact、/usage 送入 handleCommand；/exit 关闭 Session。

## 关键字段

- tasks.status：active/paused/completed/cancelled
- sessions.current_task_id：当前 Task
- turns.task_seq：Task 内顺序
- ui_runs.status：accepted/running/completed/failed/interrupted
- clientRequestId：幂等键

## 接口与服务

- POST /api/v1/tasks
- POST /api/v1/tasks/:id/actions
- GET/POST /api/v1/tasks/:id/turns
- GET /api/v1/runs/:id
- GET /api/v1/events

## 错误出口

- 历史 Task 只读：HTTP 409
- 活动 Run 时拒绝切换 Task 或并发提交
- 工具格式无效：拒绝执行工具并给出原因
- 轮次上限：停止继续执行并返回提示
- 服务重启后孤立 Run 标记 interrupted，不自动重放

## 代码依据

- [`code/src/task/task-manager.ts`](../../../code/src/task/task-manager.ts)
- [`code/src/ui/run-coordinator.ts`](../../../code/src/ui/run-coordinator.ts)
- [`code/src/loop/agent-loop.ts`](../../../code/src/loop/agent-loop.ts)
- [`code/src/ui/local-api.ts`](../../../code/src/ui/local-api.ts)
- [`code/src/cli/input-router.ts`](../../../code/src/cli/input-router.ts)

## 流程图

### Task 模块总览

[源图](diagrams/01-overview.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/local-api.ts; code/src/ui/run-coordinator.ts; code/src/loop/agent-loop.ts
flowchart TD
  A["工作台 Task 列表与固定输入框"] --> B{"用户动作"}
  B -->|新建或改变状态| R2["引用子流程 02<br/>Task 生命周期<br/>点击查看"]
  B -->|发送消息| R3["引用子流程 03<br/>Run 与 Tool Calling Loop<br/>点击查看"]
  B -->|CLI 输入| R4["引用子流程 04<br/>REPL 路由与会话结束<br/>点击查看"]
  R2 --> C["sessions.current_task_id<br/>tasks.status"]
  R3 --> D["ui_runs + turns<br/>事件流与最终回答"]
  R4 --> F["AgentKernel.submitTurn / handleCommand<br/>CLI 输出结果与产物路径"]
  D --> E["上下文和抓包<br/>按 Turn 追查"]
  click R2 call openDiagram_02_lifecycle() "查看 Task 生命周期"
  click R3 call openDiagram_03_run() "查看消息执行链路"
  click R4 call openDiagram_04_cli() "查看 CLI 输入路由"
  class A,E page;
  class B decision;
  class C,D,F service;
  class R2,R3,R4 ref;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef ref fill:#e8fff3,stroke:#159957,color:#0b5132,stroke-width:2px;
```

### Task 生命周期

[源图](diagrams/02-lifecycle.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/task/task-manager.ts; code/src/ui/local-api.ts
flowchart TD
  A["点击新建 Task<br/>POST /api/v1/tasks title"] --> B["TaskManager.create<br/>status = active"]
  B --> C["写 tasks 并选为 current_task_id"]
  C --> D{"用户操作 action"}
  D -->|switch| E["选择 active 或 paused Task"]
  D -->|pause| F["status = paused<br/>普通输入被禁止"]
  D -->|resume| G["status = active<br/>重新选为当前 Task"]
  D -->|finish| H["status = completed<br/>清空当前选择"]
  D -->|cancel| I["status = cancelled<br/>记录 close_reason"]
  D -->|compact| J["调用 /compact<br/>不创建用户 Turn"]
  D -->|历史 Task| X1["HTTP 409<br/>历史 Task 只读"]
  D -->|有活动 Run| X2["HTTP 409<br/>当前操作被拒绝"]
  class A page;
  class D decision;
  class B,C,E,F,G,H,I,J service;
  class X1,X2 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

### Turn 和工具调用循环

[源图](diagrams/03-run.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/local-api.ts; code/src/ui/run-coordinator.ts; code/src/loop/agent-loop.ts
flowchart TD
  A["发送消息<br/>POST /api/v1/tasks/:id/turns"] --> B["验证 input、clientRequestId、引用与模型"]
  B -->|无效或历史只读| X1["HTTP 400/409<br/>不创建 Run"]
  B -->|通过| C["事务写 turns + ui_runs<br/>status = accepted"]
  C -->|已有活动 Run| X2["拒绝并发 Run<br/>同幂等键返回已有 Run"]
  C --> D["异步执行<br/>status = running"]
  D --> E["AgentLoop<br/>压缩检查、ContextPack、提示词"]
  E --> F["所选模型回复<br/>llm.complete"]
  F --> G{"回复含有效工具调用?"}
  G -->|否| H["输出最终回答<br/>run.completed + Turn.completed"]
  G -->|格式无效或轮次上限| X3["拒绝工具或停止执行<br/>给出明确结果"]
  G -->|是| I["ToolCallingRuntime 顺序执行工具<br/>追加结果后再次调用模型"]
  I --> F
  D -->|执行异常| X4["run.failed<br/>Trace 保留失败原因"]
  class A,H page;
  class G decision;
  class B,C,D,E,F,I service;
  class X1,X2,X3,X4 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

### CLI/REPL 输入路由

[源图](diagrams/04-cli.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/cli/main.ts; code/src/cli/input-router.ts; code/src/kernel/agent-kernel.ts
flowchart TD
  A["npm run dev 启动 REPL<br/>AgentKernel.start 创建 Session"] --> B["figo-agent&gt; 读取一行<br/>routeInput"]
  B --> C{"输入类别?"}
  C -->|空行| D["不创建 Turn<br/>继续等待"]
  C -->|普通文本| E["kernel.submitTurn<br/>创建当前 Task 的 Turn"]
  C -->|/skill project-understanding| E
  C -->|/task、/compact、/usage| F["kernel.handleCommand<br/>更新 Task 或输出查询"]
  C -->|/context、/memory、/report| G["输出产物位置或说明<br/>不创建 Turn"]
  C -->|/exit| H["kernel.shutdown<br/>关闭 readline 与 Session"]
  C -->|未知命令| X1["显示未知命令<br/>继续等待"]
  E --> I["渲染回答与产物路径<br/>renderDispatchResult"]
  F --> I
  G --> I
  I --> B
  E -->|异常| X2["renderError 输出错误<br/>继续等待"]
  class A page;
  class C decision;
  class B,D,E,F,G,H,I service;
  class X1,X2 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

## 版本记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 Task 与 Agent 执行 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-lifecycle、03-run、04-cli | `code/src/task/task-manager.ts`、`code/src/ui/run-coordinator.ts`、`code/src/loop/agent-loop.ts`、`code/src/ui/local-api.ts`、`code/src/cli/input-router.ts` | Mermaid 浏览器渲染、点击与源图同步检查 |
