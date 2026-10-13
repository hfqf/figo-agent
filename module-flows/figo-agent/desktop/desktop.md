# 桌面首次启动

> 当前版本：v1.0.0
> 最后更新：2026-10-13
> 代码依据：code/src/desktop/main.ts；code/src/desktop/model-setup.ts；code/web/src/SetupApp.tsx

从打开 App 到完成模型设置、选择工作区与本地认证。

## 边界与入口

桌面首次启动有独立的配置门槛、窗口生命周期和本地会话边界，不能并入普通工作区操作。

入口：macOS App、首次设置页、打开工作区。

- 启动时配置放在 Electron userData/data，而不是源码目录。没有工作区或没有可用模型时先显示设置页；未主动打开工作区前不创建会话。
- 主进程启动独立服务后用本地访问码换取 HttpOnly Cookie，工作台窗口禁用 Node 集成并限制导航。
- 启动服务失败会显示错误对话框并退出；设置页取消选目录后继续停留。

## 关键字段

- configRoot：桌面用户配置根
- workspaceRoot：规范化后的用户目录
- configured：当前模型具备连接信息和 Key
- session Cookie：本地服务认证状态

## 接口与服务

- IPC figo-setup:read/save-model/pick-workspace/open-workspace
- DesktopServiceHost.start
- POST /api/v1/auth
- GET /api/v1/bootstrap

## 错误出口

- 模型未配置或目录无效：拒绝打开工作区，不创建 Session
- 服务启动失败：错误对话框并退出
- 目录选择取消：路径保持为空

## 代码依据

- [`code/src/desktop/main.ts`](../../../code/src/desktop/main.ts)
- [`code/src/desktop/model-setup.ts`](../../../code/src/desktop/model-setup.ts)
- [`code/web/src/SetupApp.tsx`](../../../code/web/src/SetupApp.tsx)

## 流程图

### 启动主流程

[源图](diagrams/01-overview.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/src/desktop/main.ts; code/src/desktop/model-setup.ts
flowchart TD
  A["启动 macOS App<br/>Desktop main"] --> B["确保 userData/data 配置存在<br/>ensureDesktopConfig"]
  B --> C{"最近工作区存在且模型已配置?"}
  C -->|否| D["模型设置页<br/>setup.html"]
  C -->|是| E["启动本地服务<br/>DesktopServiceHost.start"]
  D --> R2["引用子流程 02<br/>配置模型并打开工作区<br/>点击查看"]
  R2 --> E
  E --> F["本地访问码换取会话 Cookie<br/>authenticateDesktop"]
  F --> G["加载 Web 工作台<br/>BrowserWindow.loadURL"]
  E -->|启动失败| X["错误对话框并退出<br/>startupFailed"]
  click R2 call openDiagram_02_setup() "查看模型设置与打开工作区"
  class A,D,G page;
  class C decision;
  class B,E,F service;
  class X error;
  class R2 ref;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
  classDef ref fill:#e8fff3,stroke:#159957,color:#0b5132,stroke-width:2px;
```

### 模型设置与打开工作区

[源图](diagrams/02-setup.mmd) · [交互预览](./index.html)

```mermaid
%% flow-version: v1.0.0
%% updated-at: 2026-10-13
%% source: code/web/src/SetupApp.tsx; code/src/desktop/main.ts; code/src/desktop/model-setup.ts
flowchart TD
  A["首次启动模型设置页<br/>SetupApp"] --> B["读取脱敏模型状态和最近目录<br/>figo-setup:read"]
  B --> C["填写 API 地址、模型名称、API Key<br/>saveDesktopModelSetup"]
  C --> D{"模型连接配置有效?"}
  D -->|否| X1["显示配置错误<br/>停留设置页"]
  D -->|是| E["写入 userData/data 配置<br/>密钥不回传页面"]
  E --> F["点击浏览文件夹<br/>figo-setup:pick-workspace"]
  F --> G{"用户选中目录?"}
  G -->|取消| X2["保留设置页<br/>目录路径仍为空"]
  G -->|选中| H["规范化目录路径<br/>resolveWorkspace"]
  H --> I["点击打开工作区<br/>figo-setup:open-workspace"]
  I --> J{"模型已配置且目录有效?"}
  J -->|否| X3["拒绝打开并显示错误<br/>不创建 Session"]
  J -->|是| K["启动服务、创建工作台窗口<br/>旧设置窗口关闭"]
  class A,K page;
  class D,G,J decision;
  class B,C,E,F,H,I service;
  class X1,X2,X3 error;
  classDef page fill:#eef6ff,stroke:#2f80ed,color:#102a43;
  classDef decision fill:#fff7db,stroke:#b7791f,color:#3b2f0b;
  classDef service fill:#f0ecff,stroke:#6b46c1,color:#2d1b69;
  classDef error fill:#ffe8e8,stroke:#d93025,color:#7a1c14;
```

## 版本记录

| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-10-13 | v1.0.0 | 初建 | 按当前代码建立 桌面首次启动 主流程和子流程；原因：执行全项目业务流梳理 | 01-overview、02-setup | `code/src/desktop/main.ts`、`code/src/desktop/model-setup.ts`、`code/web/src/SetupApp.tsx` | Mermaid 浏览器渲染、点击与源图同步检查 |
