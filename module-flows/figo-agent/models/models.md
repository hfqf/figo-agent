# 模型与提示词

> 当前版本：v1.0.0
> 最后更新：2026-10-13
> 代码依据：code/src/config/model-settings.ts；code/src/ui/local-api.ts；code/web/src/SettingsPage.tsx；code/web/src/App.tsx

管理模型连接、发现模型 ID、保存默认选择和提示词。

## 边界与入口

模型连接与默认选择是运行配置的所有者；它决定下一条消息发往何处，但不拥有 Task 历史。

入口：设置页、聊天页模型选择、提示词设置。

- 配置页呈现 MiniMax、DeepSeek、GPT 官方和 GPT 中转四类服务。发现接口读取服务端模型 ID；设置读取只返回 hasApiKey，不回传 Key。
- 保存使用 version 指纹检测并发修改，配置写入 JSON。切换默认模型立即保存 activeModelId 和所选模型 ID，下一条 Run 在提交时快照。
- 系统提示词和用户指令通过独立提示词配置读写；正在执行的 Run 保持提交时所选模型。

## 关键字段

- llm[].id/enabled/baseUrl/model/apiKey：模型连接
- activeModelId：全局默认连接
- providerId/modelId：某次 Run 的模型快照
- version：配置内容指纹

## 接口与服务

- GET/PUT /api/v1/settings/models
- POST /api/v1/settings/models/discover
- GET /api/v1/models/available
- PUT /api/v1/models/default
- GET/PUT /api/v1/settings/prompts

## 错误出口

- 模型发现上游失败：HTTP 502
- 版本冲突或启用连接缺少 Key：拒绝保存
- 连接在切换期间变化：要求重启工作台
- 活动 Run 时不能修改模型连接或提示词

## 代码依据

- [`code/src/config/model-settings.ts`](../../../code/src/config/model-settings.ts)
- [`code/src/ui/local-api.ts`](../../../code/src/ui/local-api.ts)
- [`code/web/src/SettingsPage.tsx`](../../../code/web/src/SettingsPage.tsx)
- [`code/web/src/App.tsx`](../../../code/web/src/App.tsx)

## 流程图

### 模型模块总览

[源图](diagrams/01-overview.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/web/src/App.tsx; code/web/src/SettingsPage.tsx; code/src/ui/local-api.ts
flowchart TD
  A["工作台模型选择或配置页"] --> B{"用户动作"}
  B -->|管理连接| R2["引用子流程 02<br/>发现模型并保存配置<br/>点击查看"]
  B -->|切换当前模型| R3["引用子流程 03<br/>保存默认模型并用于后续 Turn<br/>点击查看"]
  B -->|编辑提示词| C["GET/PUT /api/v1/settings/prompts<br/>版本冲突时拒绝写入"]
  R2 --> D["JSON 运行配置<br/>llm 数组和 activeModelId"]
  R3 --> D
  D --> E["AgentKernel 读取模型选择<br/>下一次 Run 生效"]
  click R2 call openDiagram_02_settings() "查看模型配置"
  click R3 call openDiagram_03_switch() "查看模型切换"
  class A page;
  class B decision;
  class C,D,E service;
  class R2,R3 ref;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef ref fill:#e8fff3,stroke:#159957,color:#0b5132,stroke-width:2px;
```

### 发现并保存连接

[源图](diagrams/02-settings.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/local-api.ts; code/src/config/model-settings.ts; code/web/src/SettingsPage.tsx
flowchart TD
  A["模型配置页<br/>四类服务入口"] --> B["GET /api/v1/settings/models<br/>只返回 hasApiKey"]
  B --> C["输入 API Key 和地址<br/>选择已启用连接"]
  C --> D["POST /api/v1/settings/models/discover<br/>从服务端读取模型 ID"]
  D -->|上游失败| X1["HTTP 502<br/>显示模型列表读取失败"]
  D -->|成功| E["用户选择 model ID<br/>提交 version 和 models"]
  E --> F["PUT /api/v1/settings/models<br/>saveModelSettings"]
  F --> G{"version 匹配且配置有效?"}
  G -->|否| X2["拒绝保存<br/>配置已变化或 Key/地址无效"]
  G -->|是| H["原子写入 figo-agent.config.json<br/>响应只暴露 hasApiKey"]
  class A page;
  class G decision;
  class B,C,D,E,F,H service;
  class X1,X2 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

### 默认模型切换

[源图](diagrams/03-switch.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/web/src/App.tsx; code/src/ui/local-api.ts; code/src/config/model-settings.ts; code/src/ui/run-coordinator.ts
flowchart TD
  A["聊天页选择 providerId + modelId"] --> B["PUT /api/v1/models/default"]
  B --> C{"连接已启用且有 API Key?"}
  C -->|否| X1["HTTP 400<br/>所选模型无效或未启用"]
  C -->|是| D["保存 activeModelId 和模型 ID<br/>saveActiveModelSelection"]
  D -->|连接配置已变| X2["拒绝切换<br/>要求重启工作台"]
  D -->|成功| E["更新运行时默认选择<br/>settings.models.default.changed"]
  E --> F["下一条消息提交时<br/>ui_runs 快照 model_provider_id / model_id"]
  F --> G["AgentLoop 发送到所选模型<br/>旧 Run 保持原快照"]
  class A page;
  class C decision;
  class B,D,E,F,G service;
  class X1,X2 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

## 版本记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 模型与提示词 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-settings、03-switch | `code/src/config/model-settings.ts`、`code/src/ui/local-api.ts`、`code/web/src/SettingsPage.tsx`、`code/web/src/App.tsx` | Mermaid 浏览器渲染、点击与源图同步检查 |
