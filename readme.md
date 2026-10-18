# Figo Agent

<img src="code/assets/figo-agent-logo.png" width="64" height="64" alt="Figo Agent" />

**一个可观察、可复盘的本地 Coding Agent。** 在同一工作台中编辑文件、执行任务、检查模型请求，追踪上下文与压缩过程。CLI、Web 与 Electron 共用 Agent 内核。

![工作台：文件编辑、任务对话与执行记录](docs/agent/assets/2026-10-18-readme/screenshots/workbench.png)

> 以下界面由当前源码在隔离工作区拍摄，使用合成演示数据；对话、用量、耗时与压缩数值不代表真实模型验收。

## 从任务到复盘

[![工作台典型操作路径](docs/agent/assets/2026-10-18-readme/product.png)](docs/agent/assets/2026-10-18-readme/product.html)

浏览文件不会自动入模，文件引用需显式发送；检查器是可选的只读观察入口。[交互流程](docs/agent/assets/2026-10-18-readme/product.html) · [任务目录截图](docs/agent/assets/2026-10-18-readme/screenshots/tasks.png)

## 像抓包一样检查模型交互

![Trace Inspector：统一事件列表与模型请求](docs/agent/assets/2026-10-18-readme/screenshots/trace-request.png)

统一查看请求、响应、工具调用和原始事实，支持筛选、分页与来源定位。[Trace Inspector 文档](docs/agent/modules/ui/trace-inspector/README.md)

## 看懂上下文与压缩

![上下文流：文件与 SQLite、构建快照、摘要和模型请求](docs/agent/assets/2026-10-18-readme/screenshots/context-flow.png)

![压缩检查：摘要来源、保留边界与估算对照](docs/agent/assets/2026-10-18-readme/screenshots/compaction.png)

**准备了什么、保留了什么、实际发送了什么，分开核对。** 原文与抓包继续保存，压缩不删除历史。[Context 文档](docs/agent/modules/context/README.md)

## 技术架构

[![共享内核、静态能力装配与只读观测](docs/agent/assets/2026-10-18-readme/architecture.png)](docs/agent/assets/2026-10-18-readme/architecture.html)

CLI / Web / Electron → AgentKernel → AgentLoop；工具经 Policy 授权，SQLite 保存状态，Trace 保存事实，Reporter 生成阅读产物。[交互架构](docs/agent/assets/2026-10-18-readme/architecture.html) · [模块索引](docs/agent/modules/README.md)

<details>
<summary>展开 AgentLoop 执行流程</summary>

[![单轮主路径、工具授权与结果回填](docs/agent/assets/2026-10-18-readme/workflow.png)](docs/agent/assets/2026-10-18-readme/workflow.html)

模型与响应节点合并条件压缩、协议判定及限次恢复；异常与停止集中表示，不是逐分支状态机。[详细循环](docs/agent/modules/agent-loop/TOOL_CALLING_LOOP.md)

</details>

## 数据怎样流转

[![上下文与抓包数据流 GIF](docs/agent/assets/2026-10-18-readme/context.gif)](docs/agent/assets/2026-10-18-readme/context.html)

动效表示逻辑关系，不表示真实耗时或 Trace 回放。[交互数据流](docs/agent/assets/2026-10-18-readme/context.html) · [静态图](docs/agent/assets/2026-10-18-readme/context.png) · [图源与导出记录](docs/agent/2026-10-18-README与Archify图示更新记录.md)

## 快速开始

在仓库根目录执行：

```bash
npm --prefix code install
npm --prefix code run web:dev
```

用 Chrome 打开终端输出的地址，默认 `http://127.0.0.1:4317`；按提示输入启动访问码。在模型设置页填写 API 地址、模型和密钥，保存后对后续请求即时生效；活动 Run 期间不可保存。

CLI：`npm --prefix code run dev`。桌面内部自测版见[桌面运行与打包](docs/agent/modules/ui/desktop/IMPLEMENTATION.md)。配置说明见[模型设置](docs/agent/modules/ui/settings/README.md)与[配置边界](docs/agent/modules/agent-kernel/configuration.md)。

## 文档与边界

| 想了解什么 | 入口 |
| :--- | :--- |
| 架构、模块与实施进度 | [总览](docs/agent/v1-architecture-design.md) · [模块索引](docs/agent/modules/README.md) |
| 工作台、任务与交互 | [UI 设计](docs/agent/modules/ui/design.md) · [任务目录](docs/agent/modules/ui/2026-10-17-任务窗口优化实施与验收.md) |
| 上下文压缩与用量 | [Context](docs/agent/modules/context/README.md) · [TokenUsage](docs/agent/modules/token-usage/README.md) |
| 工具、权限与存储 | [Tool](docs/agent/modules/tool/README.md) · [Storage](docs/agent/modules/storage/README.md) |
| 测试与平台放行 | [Web 验收](docs/agent/modules/ui/ACCEPTANCE.md) · [检查器验收](docs/agent/modules/ui/trace-inspector/ACCEPTANCE.md) · [桌面验收](docs/agent/modules/ui/desktop/ACCEPTANCE.md) |

- 当前为单 Agent、静态插件；Goal / Verifier、自动长期记忆治理与动态插件尚未实现。
- 面向可信本机使用。人工 Terminal 不经过 Agent Tool Policy；真实密钥不得提交，完整抓包和运行数据按敏感数据管理。
- Pi 压缩的实际大窗口容量与普遍净收益未完整验证；桌面仍是未签名内部自测版，最新 Web 验收不等于桌面新包放行。[阶段边界](docs/agent/modules/context/2026-10-16-Pi压缩与原生工具协议阶段收尾.md)

验证入口：`npm --prefix code test`、`npm --prefix code run typecheck`、`npm --prefix code run build`；各模块验收仍须检查 Web、平台和密钥扫描条件。

可选个人知识库：`git submodule update --init -- figo-kiwi`。它不参与默认上下文，也不是构建或运行前置条件。

文档更新：2026-10-18。截图与示意图不代替功能验收。
