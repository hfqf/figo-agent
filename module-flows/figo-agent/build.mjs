import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const version = "v1.0.0";
const date = "2026-10-13";
const modules = [
  {
    id: "desktop", name: "桌面首次启动", summary: "从打开 App 到完成模型设置、选择工作区与本地认证。",
    entries: ["macOS App", "首次设置页", "打开工作区"],
    rationale: "桌面首次启动有独立的配置门槛、窗口生命周期和本地会话边界，不能并入普通工作区操作。",
    details: [
      "启动时配置放在 Electron userData/data，而不是源码目录。没有工作区或没有可用模型时先显示设置页；未主动打开工作区前不创建会话。",
      "主进程启动独立服务后用本地访问码换取 HttpOnly Cookie，工作台窗口禁用 Node 集成并限制导航。",
      "启动服务失败会显示错误对话框并退出；设置页取消选目录后继续停留。"
    ],
    fields: ["configRoot：桌面用户配置根", "workspaceRoot：规范化后的用户目录", "configured：当前模型具备连接信息和 Key", "session Cookie：本地服务认证状态"],
    apis: ["IPC figo-setup:read/save-model/pick-workspace/open-workspace", "DesktopServiceHost.start", "POST /api/v1/auth", "GET /api/v1/bootstrap"],
    errors: ["模型未配置或目录无效：拒绝打开工作区，不创建 Session", "服务启动失败：错误对话框并退出", "目录选择取消：路径保持为空"],
    sources: ["code/src/desktop/main.ts", "code/src/desktop/model-setup.ts", "code/web/src/SetupApp.tsx"],
    diagrams: [["01-overview", "启动主流程"], ["02-setup", "模型设置与打开工作区"]]
  },
  {
    id: "models", name: "模型与提示词", summary: "管理模型连接、发现模型 ID、保存默认选择和提示词。",
    entries: ["设置页", "聊天页模型选择", "提示词设置"],
    rationale: "模型连接与默认选择是运行配置的所有者；它决定下一条消息发往何处，但不拥有 Task 历史。",
    details: [
      "配置页呈现 MiniMax、DeepSeek、GPT 官方和 GPT 中转四类服务。发现接口读取服务端模型 ID；设置读取只返回 hasApiKey，不回传 Key。",
      "保存使用 version 指纹检测并发修改，配置写入 JSON。切换默认模型立即保存 activeModelId 和所选模型 ID，下一条 Run 在提交时快照。",
      "系统提示词和用户指令通过独立提示词配置读写；正在执行的 Run 保持提交时所选模型。"
    ],
    fields: ["llm[].id/enabled/baseUrl/model/apiKey：模型连接", "activeModelId：全局默认连接", "providerId/modelId：某次 Run 的模型快照", "version：配置内容指纹"],
    apis: ["GET/PUT /api/v1/settings/models", "POST /api/v1/settings/models/discover", "GET /api/v1/models/available", "PUT /api/v1/models/default", "GET/PUT /api/v1/settings/prompts"],
    errors: ["模型发现上游失败：HTTP 502", "版本冲突或启用连接缺少 Key：拒绝保存", "连接在切换期间变化：要求重启工作台", "活动 Run 时不能修改模型连接或提示词"],
    sources: ["code/src/config/model-settings.ts", "code/src/ui/local-api.ts", "code/web/src/SettingsPage.tsx", "code/web/src/App.tsx"],
    diagrams: [["01-overview", "模型模块总览"], ["02-settings", "发现并保存连接"], ["03-switch", "默认模型切换"]]
  },
  {
    id: "tasks", name: "Task 与 Agent 执行", summary: "创建任务、管理生命周期、提交 Turn，并运行工具调用循环。",
    entries: ["Task 列表", "固定输入框", "CLI/REPL", "活动流"],
    rationale: "Task 拥有对话边界和生命周期，Run 拥有异步执行状态；两者不能与模型连接或 UI 面板混为一个模块。",
    details: [
      "Session 下可有多个 Task，当前选中的 Task 记录在 sessions.current_task_id。状态包括 active、paused、completed 和 cancelled；历史 Session 的 Task 在工作台只读。",
      "发送消息提交 clientRequestId。RunCoordinator 在事务中创建 Turn 和 ui_runs，再异步运行 AgentLoop；相同幂等键返回原 Run，不并发执行第二个 Run。",
      "AgentLoop 先构造上下文并选模型，然后在有工具调用时顺序执行工具、追加结果、再次调用模型，直到最终回答或达到轮次上限。",
      "CLI 入口通过 routeInput 将普通文本送入 submitTurn，将 /task、/compact、/usage 送入 handleCommand；/exit 关闭 Session。"
    ],
    fields: ["tasks.status：active/paused/completed/cancelled", "sessions.current_task_id：当前 Task", "turns.task_seq：Task 内顺序", "ui_runs.status：accepted/running/completed/failed/interrupted", "clientRequestId：幂等键"],
    apis: ["POST /api/v1/tasks", "POST /api/v1/tasks/:id/actions", "GET/POST /api/v1/tasks/:id/turns", "GET /api/v1/runs/:id", "GET /api/v1/events"],
    errors: ["历史 Task 只读：HTTP 409", "活动 Run 时拒绝切换 Task 或并发提交", "工具格式无效：拒绝执行工具并给出原因", "轮次上限：停止继续执行并返回提示", "服务重启后孤立 Run 标记 interrupted，不自动重放"],
    sources: ["code/src/task/task-manager.ts", "code/src/ui/run-coordinator.ts", "code/src/loop/agent-loop.ts", "code/src/ui/local-api.ts", "code/src/cli/input-router.ts"],
    diagrams: [["01-overview", "Task 模块总览"], ["02-lifecycle", "Task 生命周期"], ["03-run", "Turn 和工具调用循环"], ["04-cli", "CLI/REPL 输入路由"]]
  },
  {
    id: "workspace", name: "工作区操作", summary: "切换工作区、浏览与编辑文件、执行本地终端命令。",
    entries: ["打开文件夹", "文件树与搜索", "文件窗口", "终端"],
    rationale: "工作区是文件与命令的权限边界；它与 Task 对话相关，但其路径校验、版本控制和进程生命周期独立。",
    details: [
      "工作区切换先验证绝对目录。若有活动 Run、终端命令或模型切换，服务返回 409；成功后停止旧 Kernel，创建新 Kernel 并刷新 bootstrap。",
      "文件搜索按目录队列递归，但受访问目录数和结果数限制。预览只接受安全路径和 UTF-8 文本；保存需提交预览时的 SHA-256 version，并用临时文件原子替换。",
      "终端一次只运行一条命令，记录运行状态与 exitCode；cd 更新终端 cwd，停止和超时终止命令进程组。"
    ],
    fields: ["path：工作区内相对路径", "version：文件 SHA-256", "startLine/endLine：引用范围", "terminal.status：running/completed/failed/stopped", "terminal.exitCode：命令退出码"],
    apis: ["GET /api/v1/workspaces", "POST /api/v1/workspaces/pick|open", "GET /api/v1/files/search", "GET /api/v1/files", "GET/PUT /api/v1/file", "GET/POST /api/v1/terminal", "POST /api/v1/terminal/stop"],
    errors: ["路径逃逸、隐藏敏感文件或符号链接：拒绝访问", "版本变化：拒绝覆盖，要求刷新", "二进制或过大文件：不可编辑", "终端并发命令或无效命令：拒绝运行"],
    sources: ["code/src/ui/local-api.ts", "code/src/ui/workspace-files.ts", "code/src/ui/terminal-service.ts", "code/web/src/FilePreviewPane.tsx"],
    diagrams: [["01-overview", "工作区操作总览"], ["02-files", "文件查看、编辑与引用"], ["03-terminal", "终端执行与停止"]]
  },
  {
    id: "context", name: "上下文与记忆", summary: "按 Task 重建历史、选择压缩时机并组装每轮模型输入。",
    entries: ["新 Turn", "手动 /compact", "Turn 上下文检查"],
    rationale: "上下文由程序构造，不是模型的隐式会话。Task 历史、压缩检查点、文件引用和 SQLite 记忆必须可追溯。",
    details: [
      "自动压缩由程序内部的 autoEnabled、turnThreshold 和 charThreshold 控制；只压缩连续终态前缀，并保留指定数量的原始尾部 Turn。",
      "压缩摘要使用短引用映射并校验来源 Turn ID。失败时不推进 checkpoint；ContextBuilder 发现损坏 checkpoint 时忽略它，退回原始历史。",
      "每轮从同一 Task 的更早 task_seq 读取用户输入、工具结果和助手回答，加入当前输入、显式文件引用与可选 project/user 记忆，写入 context_packs/context_items 再发送模型。换模型不会迁移旧 Session。"
    ],
    fields: ["taskId/task_seq：历史边界", "autoEnabled/turnThreshold/charThreshold：触发参数", "keepRawTurns：保留尾部", "checkpoint.throughSeq：压缩覆盖终点", "context_items.sourceRef/included：输入来源和选择状态"],
    apis: ["ContextBuilder.build", "CompactionService.compactIfNeeded", "TaskHistoryReader.list", "buildInitialMessages", "GET /api/v1/turns/:id/context"],
    errors: ["压缩响应或来源校验失败：保持原始历史", "checkpoint 损坏：忽略并回退完整历史", "不同 Task 或历史 Session：不自动拼接对话"],
    sources: ["code/src/context/context-builder.ts", "code/src/context/compaction-service.ts", "code/src/context/task-history-reader.ts", "code/src/loop/llm-message-builder.ts"],
    diagrams: [["01-overview", "上下文总览"], ["02-compaction", "压缩与失败回退"], ["03-build", "ContextPack 装配"]]
  },
  {
    id: "observability", name: "运行证据", summary: "按 Turn 查看活动、上下文、HTTP 抓包、Trace、工具记录和 Token。",
    entries: ["Task 活动流", "Turn 分析侧栏", "Debug Console"],
    rationale: "运行证据服务于排查和后续复盘，读取的是执行时落库的事实；它不参与模型流程控制。",
    details: [
      "RunCoordinator 发布 accepted/running/completed 等事件与回答增量；页面通过 SSE 游标回放和订阅后续事件。",
      "每次模型调用的请求与响应保存在 llm_http_captures，TokenUsageStore 从响应 usage 读取数值并标识 complete、partial 或 unavailable。",
      "WorkspaceQueryService 按 Turn 查询 ContextPack、抓包、Trace 和工具调用，在返回 UI 前做密钥与工作区路径脱敏。原始抓包仍保留在 SQLite 中供本地排查。"
    ],
    fields: ["event.seq：SSE 游标", "runId/turnId：执行关联键", "capture.requestId/purpose：模型请求身份", "usage.status：complete/partial/unavailable", "trace.type/source/payload：事件证据"],
    apis: ["GET /api/v1/events", "GET /api/v1/tasks/:id/activity", "GET /api/v1/tasks/:id/usage", "GET /api/v1/turns/:id/context|captures|trace|tools"],
    errors: ["不存在的 Turn：HTTP 404", "SSE 游标无效：HTTP 400；连接数超限：HTTP 429", "上游不返回 usage：标记 unavailable，不伪造 Token 值"],
    sources: ["code/src/ui/local-api.ts", "code/src/ui/workspace-query-service.ts", "code/src/llm/llm-http-capture-store.ts", "code/src/token-usage/token-usage-store.ts"],
    diagrams: [["01-overview", "运行证据总览"], ["02-inspect", "按 Turn 检查证据"]]
  }
];

const esc = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const codeLink = (path, depth = 3) => `[\`${path}\`](${"../".repeat(depth)}${path})`;
const list = (values) => values.map((value) => `- ${value}`).join("\n");

for (const module of modules) {
  const dir = join(root, module.id);
  const diagrams = await Promise.all(module.diagrams.map(async ([id, title]) => ({
    id, title, path: `diagrams/${id}.mmd`, source: (await readFile(join(dir, "diagrams", `${id}.mmd`), "utf8")).trim()
  })));
  for (const diagram of diagrams) {
    if (!diagram.source.includes(`%% flow-version: ${version}`) || !diagram.source.includes(`%% updated-at: ${date}`)) {
      throw new Error(`${module.id}/${diagram.path} 元信息版本不一致`);
    }
  }
  const record = `| ${date} | ${version} | 初建 | 按当前代码建立 ${module.name} 主流程和子流程；原因：执行全项目业务流梳理 | ${module.diagrams.map(([id]) => id).join("、")} | ${module.sources.map((source) => `\`${source}\``).join("、")} | Mermaid 浏览器渲染、点击与源图同步检查 |`;
  const md = `# ${module.name}\n\n> 当前版本：${version}\n> 最后更新：${date}\n> 代码依据：${module.sources.join("；")}\n\n${module.summary}\n\n## 边界与入口\n\n${module.rationale}\n\n入口：${module.entries.join("、")}。\n\n${module.details.map((value) => `- ${value}`).join("\n")}\n\n## 关键字段\n\n${list(module.fields)}\n\n## 接口与服务\n\n${list(module.apis)}\n\n## 错误出口\n\n${list(module.errors)}\n\n## 代码依据\n\n${module.sources.map((source) => `- ${codeLink(source)}`).join("\n")}\n\n## 流程图\n\n${diagrams.map((diagram) => `### ${diagram.title}\n\n[源图](${diagram.path}) · [交互预览](./index.html)\n\n\`\`\`mermaid\n${diagram.source}\n\`\`\``).join("\n\n")}\n\n## 版本记录\n\n| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |\n| --- | --- | --- | --- | --- | --- | --- |\n${record}\n`;
  await writeFile(join(dir, `${module.id}.md`), md);
  await writeFile(join(dir, "CHANGELOG.md"), `# ${module.name}流程变更记录\n\n| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |\n| --- | --- | --- | --- | --- | --- | --- |\n${record}\n`);
  const embedded = diagrams.map((diagram) => `<script type="application/vnd.mermaid" data-id="${diagram.id.replaceAll("-", "_")}" data-title="${esc(diagram.title)}" data-path="${diagram.path}">\n${esc(diagram.source)}\n</script>`).join("\n");
  const html = `<!doctype html>\n<html lang="zh-CN">\n<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(module.name)} - ${version}</title><link rel="stylesheet" href="../assets/module-preview.css"><script src="../assets/mermaid-10.9.8.min.js"></script></head>\n<body data-version="${version}">\n  <div class="app"><aside><h1>${esc(module.name)}</h1><div class="subtitle">${esc(module.summary)}</div><div class="version">当前版本：${version}</div><nav id="diagramNav"></nav><div class="legend"><div class="legend-title">图例</div><div class="legend-row"><span class="swatch" style="background:#eef6ff"></span>入口/页面</div><div class="legend-row"><span class="swatch" style="background:#fff7db"></span>判断/分支</div><div class="legend-row"><span class="swatch" style="background:#f0ecff"></span>服务/数据</div><div class="legend-row"><span class="swatch" style="background:#ffe8e8"></span>异常出口</div><div class="legend-row"><span class="swatch" style="background:#e8fff3"></span>引用子流程</div></div></aside><main><div class="toolbar"><div class="diagram-title"><strong id="activeTitle"></strong><span id="activeMeta"></span></div><div class="actions"><button type="button" id="zoomOut">缩小</button><button type="button" id="zoomIn">放大</button><button type="button" id="resetView">回到起点</button><button type="button" id="toggleSource">打开源图</button><a class="button" href="./${module.id}.md">打开 MD</a><a class="button" href="../index.html">返回总入口</a></div></div><div class="canvas-wrap" id="canvasWrap"><div class="canvas" id="canvas"><div class="diagram-card"><div class="mermaid" id="diagram"></div></div></div></div></main></div>\n  <section class="source-panel" id="sourcePanel"><div class="source-head"><span id="sourceTitle"></span><button type="button" id="closeSource">关闭</button></div><pre id="sourceCode"></pre></section>\n${embedded}\n<script src="../assets/module-preview.js"></script>\n</body></html>\n`;
  await writeFile(join(dir, "index.html"), html);
}

const map = (await readFile(join(root, "diagrams/01-module-map.mmd"), "utf8")).trim();
if (!map.includes(`%% flow-version: ${version}`)) throw new Error("总图版本不一致");
const moduleLinks = modules.map((module) => `| [${module.name}](./${module.id}/${module.id}.md) | [预览](./${module.id}/index.html) | ${module.summary} | ${module.entries.join("、")} |`).join("\n");
const portalReadme = `# Figo Agent 业务流程地图\n\n> 当前版本：${version}\n> 最后更新：${date}\n> 范围：当前项目 CLI、本地 Web 工作台与 macOS 桌面自测版\n\n本目录按用户目标与数据所有权划分模块，不按代码文件夹机械分组。阅读顺序：先看桌面/工作区入口，再看模型配置与 Task 执行，最后看上下文和运行证据。CLI 与 Web 复用 AgentKernel；桌面为同一工作台增加启动和本地认证边界。历史 Session 在当前工作台只读；本地图不是未来设计的承诺。\n\n| 模块 | HTML | 责任 | 入口 |\n| --- | --- | --- | --- |\n${moduleLinks}\n\n## 跨模块闭环\n\n用户打开工作区并配置模型 -> 创建/选择 Task -> 提交 Turn -> ContextBuilder 组合该 Task 历史 -> AgentLoop 调用模型和工具 -> RunCoordinator 发布活动与结果 -> 分析侧栏按 Turn 读取上下文、抓包和 Trace。模型切换只改变下一次 Run 的选择，不把历史 Session 迁移到当前 Task。\n\n\`\`\`mermaid\n${map}\n\`\`\`\n\n## 维护约定\n\n- 每个模块的 \`diagrams/*.mmd\` 是流程图源；更新后运行 \`node module-flows/figo-agent/build.mjs\` 同步 Markdown、HTML 与版本记录。\n- 修改字段、接口或主流程时先核对代码、调整版本号并补充变更说明；生成结果必须通过浏览器渲染和真实点击验收。\n- [Easy Code Flow Skill](https://gitee.com/hfqf1234/easy-code-flow-skill) 是本轮工作规范；本目录的 HTML 预览资源独立保存在 \`assets/\`。\n`;
await writeFile(join(root, "README.md"), portalReadme);
await writeFile(join(root, "CHANGELOG.md"), `# 总入口变更记录\n\n| 日期 | 版本 | 类型 | 改动与原因 | 影响范围 | 代码依据 | 验证 |\n| --- | --- | --- | --- | --- | --- | --- |\n| ${date} | ${version} | 初建 | 执行全项目流程梳理，按业务所有权拆分六个模块 | 总图、入口页与六个模块 | \`code/src/ui/local-api.ts\`、\`code/src/loop/agent-loop.ts\`、\`code/src/desktop/main.ts\` | 总图渲染、模块跳转和响应式截图检查 |\n`);
const cards = modules.map((module) => `<a class="module-card" href="./${module.id}/index.html"><span class="module-label">${esc(module.name)}</span><p>${esc(module.summary)}</p><small>${esc(module.entries.join(" · "))}</small><span class="arrow" aria-hidden="true">↗</span></a>`).join("\n");
const portal = `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Figo Agent 业务流程地图</title><script src="./assets/mermaid-10.9.8.min.js"></script><style>\n:root{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202936;background:#f7f9fb}*{box-sizing:border-box}body{margin:0;overflow-x:hidden}.portal{width:min(100% - 40px,1180px);margin:0 auto;padding:36px 0 72px}header{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;border-bottom:1px solid #d5dde5;padding-bottom:24px}h1{font-size:30px;margin:0 0 8px}header p{margin:0;color:#566372;line-height:1.6}.header-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.version{color:#136843;font-size:13px;font-weight:700}.header-actions a{font-size:13px;color:#145b83;text-decoration:none}.section-title{font-size:16px;margin:32px 0 16px}.module-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.module-card{position:relative;display:block;min-width:0;min-height:176px;overflow:hidden;text-decoration:none;color:inherit;background:#fff;border:1px solid #d9e2e9;border-radius:6px;padding:18px 18px 40px}.module-card:hover,.module-card:focus-visible{border-color:#198660;box-shadow:0 3px 12px #d7e7e0}.module-label{font-weight:700;font-size:16px}.module-card p{color:#394858;line-height:1.55;font-size:14px;overflow-wrap:anywhere;word-break:break-word}.module-card small{display:block;color:#687784;overflow-wrap:anywhere;word-break:break-word}.arrow{position:absolute;right:16px;bottom:12px;color:#137453}.map{background:#fff;border:1px solid #d9e2e9;border-radius:6px;padding:12px;overflow:auto}.map svg{max-width:none}.note{font-size:14px;color:#4c5c6a;line-height:1.7;max-width:880px}@media(max-width:1180px){.module-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:900px){.module-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:640px){.portal{width:min(100% - 28px,1180px);padding-top:22px}header{display:block}h1{font-size:25px}.header-actions{margin-top:14px}.module-grid{grid-template-columns:1fr}.module-card{min-height:140px}}\n</style></head><body><div class="portal"><header><div><h1>Figo Agent 业务流程地图</h1><p>从用户入口、状态变化到模型请求与执行证据。</p></div><div class="header-actions"><span class="version">当前版本：${version}</span><a href="./README.md">README</a><a href="./CHANGELOG.md">CHANGELOG</a></div></header><h2 class="section-title">业务模块</h2><div class="module-grid">${cards}</div><h2 class="section-title">跨模块流转</h2><div class="map"><div class="mermaid" id="moduleMap"></div></div><p class="note">选择一个模块可查看交互流程图、字段、接口、失败出口与对应代码。历史 Session 在当前工作台只读。</p></div><script type="application/vnd.mermaid" id="mapSource">${esc(map)}</script><script>mermaid.initialize({startOnLoad:false,securityLevel:'loose',theme:'base',flowchart:{htmlLabels:true,useMaxWidth:false}});const el=document.createElement('textarea');el.innerHTML=document.getElementById('mapSource').textContent;document.getElementById('moduleMap').textContent=el.value;mermaid.run({nodes:[document.getElementById('moduleMap')]});</script></body></html>\n`;
await writeFile(join(root, "index.html"), portal);
process.stdout.write(`已生成 ${modules.length} 个模块的 Markdown、HTML 与变更记录。\n`);
