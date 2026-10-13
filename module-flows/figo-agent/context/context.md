# 上下文与记忆

> 当前版本：v1.0.0
> 最后更新：2026-10-13
> 代码依据：code/src/context/context-builder.ts；code/src/context/compaction-service.ts；code/src/context/task-history-reader.ts；code/src/loop/llm-message-builder.ts

按 Task 重建历史、选择压缩时机并组装每轮模型输入。

## 边界与入口

上下文由程序构造，不是模型的隐式会话。Task 历史、压缩检查点、文件引用和 SQLite 记忆必须可追溯。

入口：新 Turn、手动 /compact、Turn 上下文检查。

- 自动压缩由程序内部的 autoEnabled、turnThreshold 和 charThreshold 控制；只压缩连续终态前缀，并保留指定数量的原始尾部 Turn。
- 压缩摘要使用短引用映射并校验来源 Turn ID。失败时不推进 checkpoint；ContextBuilder 发现损坏 checkpoint 时忽略它，退回原始历史。
- 每轮从同一 Task 的更早 task_seq 读取用户输入、工具结果和助手回答，加入当前输入、显式文件引用与可选 project/user 记忆，写入 context_packs/context_items 再发送模型。换模型不会迁移旧 Session。

## 关键字段

- taskId/task_seq：历史边界
- autoEnabled/turnThreshold/charThreshold：触发参数
- keepRawTurns：保留尾部
- checkpoint.throughSeq：压缩覆盖终点
- context_items.sourceRef/included：输入来源和选择状态

## 接口与服务

- ContextBuilder.build
- CompactionService.compactIfNeeded
- TaskHistoryReader.list
- buildInitialMessages
- GET /api/v1/turns/:id/context

## 错误出口

- 压缩响应或来源校验失败：保持原始历史
- checkpoint 损坏：忽略并回退完整历史
- 不同 Task 或历史 Session：不自动拼接对话

## 代码依据

- [`code/src/context/context-builder.ts`](../../../code/src/context/context-builder.ts)
- [`code/src/context/compaction-service.ts`](../../../code/src/context/compaction-service.ts)
- [`code/src/context/task-history-reader.ts`](../../../code/src/context/task-history-reader.ts)
- [`code/src/loop/llm-message-builder.ts`](../../../code/src/loop/llm-message-builder.ts)

## 流程图

### 上下文总览

[源图](diagrams/01-overview.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/loop/agent-loop.ts; code/src/context/context-builder.ts
flowchart TD
  A["新 Turn 开始<br/>AgentLoop"] --> R2["引用子流程 02<br/>自动压缩与失败回退<br/>点击查看"]
  R2 --> R3["引用子流程 03<br/>装配 ContextPack<br/>点击查看"]
  R3 --> B["系统提示词 + 用户指令 + ContextPack<br/>buildInitialMessages"]
  B --> C["所选模型收到新请求<br/>不是继承旧模型私有状态"]
  C --> D["context_packs / context_items<br/>留作本轮输入证据"]
  click R2 call openDiagram_02_compaction() "查看压缩流程"
  click R3 call openDiagram_03_build() "查看上下文装配"
  class A page;
  class B,C,D service;
  class R2,R3 ref;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef ref fill:#e8fff3,stroke:#159957,color:#0b5132,stroke-width:2px;
```

### 压缩与失败回退

[源图](diagrams/02-compaction.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/context/compaction-policy.ts; code/src/context/compaction-service.ts; code/src/context/compaction-summary.ts
flowchart TD
  A["读取当前 Task 未压缩历史<br/>taskId + beforeSeq"] --> B{"autoEnabled 且达到阈值?"}
  B -->|否| X1["跳过自动压缩<br/>原始历史保留"]
  B -->|是| C["仅选连续终态前缀<br/>保留 keepRawTurns 条尾部 Turn"]
  C --> D{"存在可压缩 Turn?"}
  D -->|否| X2["compaction.skipped<br/>无可压缩前缀"]
  D -->|是| E["短引用 t1..tn 发送所选模型<br/>purpose = task_compaction"]
  E --> F{"摘要 JSON 与来源 ID 校验通过?"}
  F -->|否| X3["compaction.failed<br/>不推进 checkpoint"]
  F -->|是| G["追加 task_compaction_checkpoints<br/>保留覆盖范围与 requestId"]
  G --> H["后续 ContextBuilder<br/>摘要替代已覆盖原始 Turn"]
  class A page;
  class B,D,F decision;
  class C,E,G,H service;
  class X1,X2,X3 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

### ContextPack 装配

[源图](diagrams/03-build.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/context/context-builder.ts; code/src/context/task-history-reader.ts; code/src/loop/llm-message-builder.ts
flowchart TD
  A["ContextBuilder.build<br/>当前输入、taskId、turnId"] --> B["TaskHistoryReader.list<br/>只读同 Task 的更早 task_seq"]
  B --> C{"最新 checkpoint 来源校验通过?"}
  C -->|否| D["忽略损坏 checkpoint<br/>使用完整原始历史"]
  C -->|是| E["加入压缩摘要<br/>只保留未覆盖历史 Turn"]
  D --> F["加入当前用户输入"]
  E --> F
  F --> G["加入显式文件引用<br/>path、行号、version"]
  G --> H{"includeMemory?"}
  H -->|是| I["检索 SQLite project/user 记忆"]
  H -->|否| J["写 context_packs / context_items"]
  I --> J
  J --> K["buildInitialMessages<br/>system + user 内容发送模型"]
  class A page;
  class C,H decision;
  class B,D,E,F,G,I,J,K service;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
```

## 版本记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 上下文与记忆 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-compaction、03-build | `code/src/context/context-builder.ts`、`code/src/context/compaction-service.ts`、`code/src/context/task-history-reader.ts`、`code/src/loop/llm-message-builder.ts` | Mermaid 浏览器渲染、点击与源图同步检查 |
