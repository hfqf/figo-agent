# 工作区操作

> 当前版本：v1.0.0
> 最后更新：2026-10-13
> 代码依据：code/src/ui/local-api.ts；code/src/ui/workspace-files.ts；code/src/ui/terminal-service.ts；code/web/src/FilePreviewPane.tsx

切换工作区、浏览与编辑文件、执行本地终端命令。

## 边界与入口

工作区是文件与命令的权限边界；它与 Task 对话相关，但其路径校验、版本控制和进程生命周期独立。

入口：打开文件夹、文件树与搜索、文件窗口、终端。

- 工作区切换先验证绝对目录。若有活动 Run、终端命令或模型切换，服务返回 409；成功后停止旧 Kernel，创建新 Kernel 并刷新 bootstrap。
- 文件搜索按目录队列递归，但受访问目录数和结果数限制。预览只接受安全路径和 UTF-8 文本；保存需提交预览时的 SHA-256 version，并用临时文件原子替换。
- 终端一次只运行一条命令，记录运行状态与 exitCode；cd 更新终端 cwd，停止和超时终止命令进程组。

## 关键字段

- path：工作区内相对路径
- version：文件 SHA-256
- startLine/endLine：引用范围
- terminal.status：running/completed/failed/stopped
- terminal.exitCode：命令退出码

## 接口与服务

- GET /api/v1/workspaces
- POST /api/v1/workspaces/pick|open
- GET /api/v1/files/search
- GET /api/v1/files
- GET/PUT /api/v1/file
- GET/POST /api/v1/terminal
- POST /api/v1/terminal/stop

## 错误出口

- 路径逃逸、隐藏敏感文件或符号链接：拒绝访问
- 版本变化：拒绝覆盖，要求刷新
- 二进制或过大文件：不可编辑
- 终端并发命令或无效命令：拒绝运行

## 代码依据

- [`code/src/ui/local-api.ts`](../../../code/src/ui/local-api.ts)
- [`code/src/ui/workspace-files.ts`](../../../code/src/ui/workspace-files.ts)
- [`code/src/ui/terminal-service.ts`](../../../code/src/ui/terminal-service.ts)
- [`code/web/src/FilePreviewPane.tsx`](../../../code/web/src/FilePreviewPane.tsx)

## 流程图

### 工作区操作总览

[源图](diagrams/01-overview.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/local-api.ts; code/src/ui/workspace-files.ts; code/src/ui/terminal-service.ts
flowchart TD
  A["工作台打开工作区"] --> B{"用户操作"}
  B -->|浏览和编辑| R2["引用子流程 02<br/>文件预览、保存、引用<br/>点击查看"]
  B -->|执行命令| R3["引用子流程 03<br/>终端执行与停止<br/>点击查看"]
  B -->|切换目录| C["POST /api/v1/workspaces/open<br/>启动新 Kernel"]
  C -->|活动 Run 或终端未结束| X["HTTP 409<br/>拒绝切换工作区"]
  C -->|成功| D["关闭旧服务上下文<br/>更新最近目录与 bootstrap"]
  click R2 call openDiagram_02_files() "查看文件流程"
  click R3 call openDiagram_03_terminal() "查看终端流程"
  class A page;
  class B decision;
  class C,D service;
  class X error;
  class R2,R3 ref;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
  classDef ref fill:#e8fff3,stroke:#159957,color:#0b5132,stroke-width:2px;
```

### 文件查看、编辑与引用

[源图](diagrams/02-files.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/workspace-files.ts; code/src/ui/local-api.ts; code/web/src/FilePreviewPane.tsx
flowchart TD
  A["文件树或搜索<br/>GET /api/v1/files 或 /files/search"] --> B["WorkspaceFileService<br/>限定工作区根目录"]
  B --> C["点击文件<br/>GET /api/v1/file?path"]
  C --> D{"文本且未超过预览上限?"}
  D -->|否| X1["拒绝二进制或标记 tooLarge<br/>不进入编辑"]
  D -->|是| E["返回 content + SHA-256 version<br/>在文件窗口直接编辑"]
  E --> F["显式保存<br/>PUT /api/v1/file path/content/version"]
  F --> G{"路径安全且 version 未变化?"}
  G -->|否| X2["路径拒绝或 HTTP 409<br/>提示刷新预览"]
  G -->|是| H["临时文件写入、同步并 rename<br/>file.saved 事件"]
  E --> I["向 Turn 引用行区间<br/>startLine/endLine/version"]
  I --> J["validateReference 复核文件版本<br/>有效内容进入 ContextPack"]
  class A,E page;
  class D,G decision;
  class B,C,F,H,I,J service;
  class X1,X2 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

### 终端执行与停止

[源图](diagrams/03-terminal.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/ui/terminal-service.ts; code/src/ui/local-api.ts
flowchart TD
  A["工作台终端输入命令<br/>POST /api/v1/terminal"] --> B{"命令有效且无运行中的命令?"}
  B -->|否| X1["拒绝空命令、超长命令或并发命令"]
  B -->|是| C["TerminalService.execute<br/>terminal.started 事件"]
  C --> D{"是否 cd 命令?"}
  D -->|是| E["解析并验证目标目录<br/>更新终端 cwd"]
  D -->|否| F["spawn SHELL -lc<br/>cwd = 当前终端目录"]
  F --> G{"退出、超时或用户停止?"}
  G -->|正常退出| H["completed 或 failed<br/>记录 exitCode"]
  G -->|停止或超时| I["SIGTERM 进程组<br/>status = stopped"]
  E -->|目录无效| X2["status = failed<br/>输出目录错误"]
  E -->|成功| H
  H --> J["terminal.* 事件<br/>页面刷新输出"]
  I --> J
  class A page;
  class B,D,G decision;
  class C,E,F,H,I,J service;
  class X1,X2 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

## 版本记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 工作区操作 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-files、03-terminal | `code/src/ui/local-api.ts`、`code/src/ui/workspace-files.ts`、`code/src/ui/terminal-service.ts`、`code/web/src/FilePreviewPane.tsx` | Mermaid 浏览器渲染、点击与源图同步检查 |
