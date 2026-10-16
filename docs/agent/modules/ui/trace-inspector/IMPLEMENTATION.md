# Trace Inspector 实施说明

## 一、状态与边界

2026-10-16 Windows 本地 Web 研究版验收通过：完整串行 80 文件、796 项，浏览器 16 组检查。功能与交互以[专项设计](./2026-10-14-TraceInspector实施设计.md)为依据，并发超时及未验证平台边界见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

本次只增加观察能力，不调整 Pi 压缩算法、模型窗口、参数、工具策略或工具执行次数。不重新进行已经收尾的压缩收益实验。用户后续授权了真实模型自测，但检查器基础验收使用隔离数据，无需付费调用。

## 二、职责分层

| 层 | 位置 | 职责 |
| :--- | :--- | :--- |
| 契约 | `code/src/contracts/trace-inspector.ts` | 列表、详情、关联强度、未知值和截断语义 |
| 查询 | `code/src/ui/trace-inspector-*.ts` | 统一事实投影、稳定分页、原始引用关联、受限读取和脱敏 |
| HTTP | `code/src/ui/trace-inspector-api.ts`、`local-api.ts` | 参数校验、只读路由，复用同源、认证和错误处理 |
| 展示 | `code/web/src/TraceInspector*.tsx`、`trace-inspector-*` | 全屏检查器、共享选择、各标签和导出 |
| 观测补点 | `agent-loop.ts`、`compaction-service.ts`、`pi-summary.ts` | 请求当时的来源引用、压缩尝试和实际摘要请求 ID |
| 验收夹具 | `code/e2e/trace-inspector-fixture.ts` | 临时工作区和真实 SQLite 结构，不访问模型 |

浏览器只调用本地只读 API。服务端读取 SQLite 的已有事实，不调用 AgentLoop；复制与导出使用脱敏后的返回对象。查询与运行服务保持职责隔离。

## 三、数据流与证据

1. 运行时将实际追加消息保存在 `context_messages`，抓包保存在 `llm_http_captures`，摘要条目保存在 `context_compactions`。
2. `llm.called.payload.projection` 记录本次请求的 `compactionEntryId`、`legacyCheckpointId`、有序 `sourceRefs` 和 `usageScope`，不重复保存消息正文。旧 JSON 摘要也保留实际引用，不冒充消息级覆盖范围。
3. 每次压缩检查使用独立 `compactionAttemptId`；请求、开始、跳过、失败和提交结果按此关联。失败的摘要请求也保留 `requestIds`。
4. 超限重试通过 `recoveryOfRequestId` 指向失败请求，原抓包、工具记录和消息原文不删除。
5. 查询按明确 ID 关联；仅同 Task / Turn 的记录标为范围关联。同毫秒排序只保证稳定显示，不代表因果。
6. 历史请求按当次投影解释，不使用最新摘要或当前 `omitted` 倒推。旧数据没有投影时显示未知，仍可查看实际抓包。
7. 新 Markdown 条目与旧 JSON 检查点分开解释。条目已保存、完成事件存在、后续请求实际使用是三种独立证据。
8. 用量保持请求级实际值；估算、混合观测和未知值分别展示。压缩前后变化不等于任务费用收益。

## 四、查询和交互细节

- 列表默认每页 200 条，最大 500 条；正常分页使用包含筛选指纹的稳定 keyset 游标。`latest=true` 读取最近窗口并按正序展示，不能与普通游标混用。
- Live 重新读取最近 500 条事实，保留选中事件与请求，不使用最后时间游标假定所有新落库记录都具有更晚的业务时间。尾窗口不等于完整 Task，暂停后可返回普通分页。
- 事件表最多保留 500 行；详情集合和正文另有限额。超限明确提示，不截坏关键 ID 或来源引用来伪装完整记录。
- 已知根引用对应的抓包或条目尚未落库时允许降级阅读；任意未知选择和已存在的跨 Task 引用仍拒绝。
- 旧的 `legacy_ses_*` 虚拟 Task 按 Session 与空 Task 归属只读查询，不迁移旧数据，也不混入其他 Session。
- `GET /api/v1/trace-inspector/file?path=...` 提供独立脱敏的当前文件预览，保留原编辑器协议；执行时快照与当前文件不会互相覆盖。
- 全屏入口不卸载工作台。Task / 工作区切换、请求切换使用作用域和异步代次保护；搜索筛选不能合并上一筛选结果。

## 五、实施与验证顺序

先验证查询与 API，再验证页面、请求切换、上下文和压缩，最后执行全量回归与浏览器截图。可并行准备代码，但前置门槛未通过不能放行集成。

专项测试覆盖数据来源、只读权限、分页、脱敏、历史投影及前端状态。浏览器验收覆盖桌面与窄屏、七标签、压缩二级标签、来源快照、导出和返回草稿。具体命令、结果与截图由验收记录留存，不将效果图或静态渲染测试当成浏览器验收通过。

可复现命令：先在 `code/` 执行 `npm run web:build`，再运行 `npm run web:test:trace`。截图由真实浏览器和本地 API 生成，不包含模型联网调用。`npm run web:demo:trace` 启动隔离演示，默认地址为 `http://127.0.0.1:4318`；停止后删除临时夹具。
