# 桌面端测试验收文档

> 状态：macOS arm64 内部自测通过核心启动与交互链路，公开发行门槛未通过。下表把已验证项与未验证项分开记录。

## 1. 证据规则

2026-10-18 最新瘦身构建：Mac ZIP 为 114.09 MiB、Windows NSIS 为 101.64 MiB。101 文件、1064 项回归、Mac 解压包烟测/窗口/首次启动与 Windows 最终载荷静态校验通过。完整对照、最新哈希和未放行项见[桌面安装包瘦身与对照验收](./2026-10-18-桌面安装包瘦身与对照验收.md)。下方较早的字节数和哈希保留为历史记录，不代表当前产物。

每项记录平台与架构、Electron/内置 Node 版本、安装包哈希、测试命令、通过/失败输出、截图或日志位置、对应 SQLite 记录及人工结论。测试用临时工作区与空密钥模板；真实模型验收由测试者本机提供密钥，输出必须脱敏。旧 Web/CLI 回归和桌面安装包验收均要通过，才允许进入对应发布阶段。

## 2. 阶段门槛

| 门槛 | 测试与证据 | 禁止放行条件 |
| :--- | :--- | :--- |
| 服务装配 | `npm --prefix code test`、`npm --prefix code run typecheck`、`npm --prefix code run build`；从任意工作目录启动参数化服务并读取 Web 静态资源 | 依赖源码当前目录、固定端口冲突、资源丢失、数据库句柄未关闭 |
| 前端与既有协议 | `npm --prefix code run web:typecheck`、`npm --prefix code run web:build`、`npm --prefix code run web:test:e2e`；对比 API DTO、SSE 顺序与历史 Turn | Web/CLI 退化、桌面另写 AgentLoop 或事实来源 |
| Electron 进程 | `npm --prefix code test -- tests/desktop`、`desktop:test:e2e:package`、`desktop:test:active-exit:package`；服务崩溃、活动 Run 退出、单实例锁已在包内窗口验证，启动超时已在单元测试验证 | 空白可操作窗口、孤儿服务、活动 Run 被标为成功、密钥进入进程日志 |
| SQLite 安装包烟测 | `npm --prefix code run desktop:verify:package`；解压最终 ZIP，在包内执行 `DatabaseSync(':memory:')` 及临时文件数据库建表/插入/读取/关闭，记录版本 | 仅在系统 Node 或未打包 Electron 中测试；安装包内模块不存在或读写失败 |
| 数据与迁移 | 首次启动创建单个可写运行配置；导入旧配置前备份；重启读取同一工作区旧 Task/Turn/Trace，保留窗口布局；重复导入不重复搬迁 | 改写旧工作区 SQLite、密钥进入包或日志、迁移失败后无原件/备份 |
| 桌面安全 | 无授权本机 HTTP 请求返回 401；错误 Host/Origin 与缺失 CSRF 拒绝；检查 `nodeIntegration=false`、`contextIsolation=true`、`sandbox=true`、外部导航拒绝 | `web.requireAccessCode=false` 使桌面 API 免鉴权；通用 IPC Shell/文件系统暴露；认证凭据进入 URL 或前端持久存储 |
| macOS 用户链路 | 安装后先进入模型设置页，用户主动打开目录后提交 Turn、编辑并保存文件、执行终端、查看抓包/Trace、退出重启复核数据 | 启动前强制选目录、创建假工作区 Session、必须安装 Node/npm/tsx、前端空白、模型密钥泄漏、事实记录与页面不一致 |
| 公开发行 | 安装包内容扫描、签名/公证、升级保留 `userData` 与工作区数据；目标系统独立安装测试 | 未签名包标为公开版；只凭 macOS 结果宣布 Windows/Linux 支持；升级覆盖用户数据 |

## 3. 异常路径专项

1. 最近工作区已删除或不可读时，选择新目录；取消选择后无 Session、无服务残留。
2. 原端口被占用时由系统分配新端口；同一端口的旧 Cookie 不复用到新进程。
3. 服务进程在模型请求中退出时，窗口显示失联，重启只恢复已落库事实，不重放写文件、Git 或命令 Tool。
4. 有活动 Run 或终端命令时退出，用户可选择等待或强制退出；等待有界，强制退出后不能留下“已完成”的虚假状态。
5. 配置文件损坏、导入失败、磁盘不可写、静态资源缺失时显示明确错误，拒绝以默认工作区或默认模型继续执行。
6. 文件选择器返回工作区外路径、符号链接或无权限目录时，仍由 `resolveWorkspace()` 与现有文件边界检查拒绝。

## 4. 平台矩阵与记录

| 平台 | 构建 | 安装启动 | SQLite | 原生选目录 | Shell/Git | 签名/升级 | 状态 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| macOS Apple Silicon | 通过 | ZIP 解压窗口 E2E 及真实模型单轮通过 | 通过 | 选择器注入链路通过，系统对话框未人工验收 | 包内 Shell/Git E2E 通过 | 未签名/未验升级 | 内部自测，不公开发行 |
| macOS Intel | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 未实施 |
| Windows x64 | NSIS 交叉构建与载荷静态检查通过 | 待验收 | 待验收 | 待验收 | 待验收 | 未签名/未验升级 | 已生成内部验证安装器，不放行运行或公开发行 |
| Linux x64 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 待验收 | 未实施 |

只对完成全部必需格子的目标平台放行。截图、日志与报告不得包含真实 API Key、未脱敏抓包或用户私人工作区内容。

2026-10-18 Windows x64：`0.0.1-beta` NSIS `.exe` 已生成，116,431,928 字节。100 文件、1060 项回归和类型构建通过；应用归档含两张引导图，122 个文本文件密钥扫描为 0；最终安装器中的主程序和归档已与已检查应用包逐一核对哈希。未在 Windows 安装或运行，SQLite、交互、签名与升级门槛仍未通过。完整哈希、构建命令和待验清单见[Windows 安装包构建与验收](./2026-10-18-Windows安装包构建与验收.md)。

## 5. 本轮执行记录（2026-10-12）

| 范围 | 证据 | 结论 |
| :--- | :--- | :--- |
| 旧功能回归 | `npm --prefix code test`：59 文件、181 测试；`typecheck`、`web:typecheck`、`web:test:e2e` | 通过 |
| 首次设置 | `desktop:test:first-run` 与 `desktop:test:first-run:package`：直接显示模型设置页；空密钥不能选目录；保存模型前无工作区 Session；密钥不经读取 IPC 返回；注入系统选择器的取消不离开设置页，主动选择并打开后才启动工作台；截图 `/tmp/figo-desktop-first-run.png` | 开发态与最新 ZIP 解压应用通过；系统原生弹窗真人操作未验 |
| 桌面窗口 | `desktop:test:e2e` 与 `desktop:test:e2e:package`：单实例锁、文件保存、终端 `pwd` 与 `git status`、本地模拟模型请求、抓包、重启后历史对话、旧 Cookie 401、目录选择器注入与切换；终止 Node utility 进程后，窗口显示连接中断且错误提示仅出现一次；截图 `/tmp/figo-desktop-electron.png` | 开发态与 ZIP 解压应用通过；系统原生目录弹窗及取消流程未人工验收 |
| 事实链路 | 最近一次包内模拟模型 E2E 的 Turn `turn_2068c9f4-e2ce-4d61-83f7-784cc8f72bf4`、抓包 `llm_cap_453d16c4-d026-4bfa-99b8-226d6dbd2b42`，SQLite 查询断言抓包存在；临时工作区测试后已删除 | 通过 |
| 真实模型 | `desktop:test:real` 与 `desktop:test:real:package` 均用本机当前启用的 `gpt-relay` 提交单轮 Turn，检查非占位答复、成功抓包及抓包内容无 API Key；最近一次安装包测试 Turn `turn_087e51ca-cd2d-48ac-b148-4cb3320ca637`，1 条抓包，响应 10 字；测试数据已删除 | 开发态与 ZIP 解压应用通过；未验证流式首段、失败抓包、其他模型及真实模型多轮工具调用 |
| 服务进程退出 | `service-host.test.ts` 验证服务失败后退出只通知一次、强制关闭等待子进程 `exit`、启动 20 秒超时后杀死子进程并拒绝启动；`desktop:test:e2e:package` 终止 Node utility 进程，窗口断线且只提示一次 | 单元和包内崩溃窗口测试通过；启动失败时的窗口反馈未做包内 E2E |
| 活动 Run 退出 | `desktop:test:active-exit` 与 `desktop:test:active-exit:package` 使用保持连接的本地模型：先选“继续等待”，Run 仍 `running`；再选“强制退出”，重启后 Run 为 `interrupted`、Turn 为 `failed`，模型请求计数仍为 1；包内 Run `run_494d4a23-6a40-4dcf-8c3a-264a2f828ad2` | 开发态与 ZIP 解压应用通过；测试只覆盖模型请求中的 Run，未覆盖运行中终端及有副作用 Tool |
| 空密钥防护 | `start-workbench.test.ts` 验证 bootstrap `modelConfigured=false`、Turn POST 返回 409 且 turns 表保持 0 行；ZIP 解压烟测验证同一状态，页面禁用发送 | 通过；仅桌面模式强制此门槛，Web/CLI 原行为未改 |
| 本地授权 | 桌面 E2E 把 `web.requireAccessCode` 设为 `false`；窗口自动认证进入，独立无 Cookie 请求返回 401；重启后专属分区生成新 Cookie，旧 Cookie 对新服务返回 401 | 通过 |
| Electron SQLite | 开发态与 ZIP 解压后运行均报告 Electron 44.7.0、Node v24.21.0、SQLite 3.53.4；内存库和文件库均实际写读 | 通过 |
| 资源与敏感数据 | `desktop:verify:package` 检查 `app.asar` 包含主入口、服务、Web 静态资源、中文资源，不包含配置、`.figo-agent`、测试或 `node_modules`；ZIP 解压后启动与静态 JS 请求通过 | 通过 |
| 构建产物 | `code/out/make/zip/darwin/arm64/Figo Agent-darwin-arm64-0.1.0.zip`，SHA-256 `8dcad6cbdd271c683752c567d4a3ef8fe803709fb8869b4ae98503a59bf7078e` | 仅内部自测；未完成正式签名/公证 |

**当前无失败的已执行测试。** macOS 内部自测仍缺原生目录弹窗/取消的人工验收、菜单导入旧配置及失败回滚的包内验收、启动失败窗口反馈、桌面安全边界与异常路径专项、窗口布局重启保持、流式首段/失败抓包，以及运行中终端和有副作用 Tool 的退出恢复证据。公开发行另缺升级回滚、正式签名/公证及目标平台独立验收；macOS Intel、Windows/Linux 均未实施验收。
