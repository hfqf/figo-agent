# Tool 模块设计

## write_file 参数契约补齐（2026-10-16）

`write_file` 已向模型声明 `path`、`content` 和 `createDirs`，文本协议与原生调用共用工具注册表中的同一份 Schema。父目录缺失时须显式传 `createDirs: true`；省略或传 `false` 不创建目录。工具描述、参数说明存入中文语言资源，运行逻辑不读取本文档。

该修复源于实际 Task 中的写入失败：执行器已有创建父目录能力，但此前发送给模型的是空参数定义。实现、红绿测试和放行边界见 [write_file 参数契约修复验收](./2026-10-16-write_file参数契约修复验收.md)。本轮未改变默认写入行为、权限控制、AgentLoop 或压缩策略。

## 文档索引信息

- 背景：本文档位于 `docs/agent/modules/tool/`，用于沉淀 Figo Agent V1 的 Tool 模块设计。
- 目标：讲清 Tool 的原子能力边界、ToolRegistry、结构化输入输出、Policy 校验、Trace 记录和 V1 最小 Tool 集。
- 标签：Tool、工具调用、原子能力、只读工具、权限边界、Trace。
- 适用范围：V1 Tool 实现、后续 `apply_patch`、`run_command`、Git 工具和受控执行设计。
- 后续可用方向：受控执行、权限策略、工具生态、MCP 工具接入和文章素材。

## 1. 模块定位

Tool 是 agent 可调用的原子动作。

在 V1 中，Tool 只提供最小只读能力：

1. `list_files`
2. `read_file`
3. `search_text`

Tool 不表达任务方法。任务方法由 Skill 负责。

V1.2 开始补齐受控执行 Tool 能力，目标是让 agent 能查询本机配置、读写工作区、执行验证命令、操作 Git、访问网络和浏览器，从而支撑真实开发验证闭环。

## 2. 设计动机

Agent 要操作外部世界，必须通过工具。工具设计决定了 agent 的能力边界和风险边界。

Tool 必须小而稳定：

1. 小：每个 Tool 只做一个原子动作。
2. 稳：输入输出结构化。
3. 可控：每次调用经过 Policy。
4. 可查：每次调用写入 Trace 和 SQLite。
5. 可组合：Skill 组合多个 Tool 完成任务。

## 3. Tool 和 Skill 的边界

| 维度 | Tool | Skill |
| :--- | :--- | :--- |
| 定位 | 原子动作 | 任务方法 |
| 示例 | `read_file` | `project-understanding-skill` |
| 控制点 | 参数、权限、执行结果 | 流程、上下文、输出结构 |
| 失败粒度 | 文件不存在、参数错误 | 上下文不足、流程失败 |
| 复用方式 | 被多个 Skill 调用 | 组合多个 Tool |

边界规则：

1. AgentLoop 不直接操作文件系统。
2. Skill 不绕过 Tool 执行动作。
3. Tool 不包含任务流程。
4. Tool 不生成最终报告。
5. ToolResult 必须结构化。

## 4. 职责边界

Tool 模块负责：

1. 定义 Tool 接口。
2. 注册 Tool。
3. 校验 Tool 输入。
4. 调用 Policy。
5. 执行原子动作。
6. 返回 ToolResult。
7. 写入 tool_calls。
8. 写入 Tool 相关 TraceEvent。

Tool 模块不负责：

1. 不决定是否执行某个任务。
2. 不决定上下文取舍。
3. 不直接生成 Markdown 报告。
4. 不直接写 Memory。
5. 不做多步骤计划。

## 5. 输入输出

输入：

1. Tool 名称。
2. 结构化参数。
3. ToolExecutionContext。
4. PolicyDecision。

输出：

1. ToolResult。
2. tool_calls SQLite 记录。
3. Tool 相关 TraceEvent。
4. 给 SkillRunResult 汇总的结果摘要。

## 6. Tool 生命周期

```text
注册
  -> 查询
  -> 参数校验
  -> Policy 校验
  -> 执行
  -> 结构化返回
  -> 写 tool_calls
  -> 写 TraceEvent
```

## 7. 运行流程图

```mermaid
flowchart TD
  Request[Tool 调用请求] --> Lookup[ToolRegistry 查找]
  Lookup --> Validate[校验 inputSchema]
  Validate --> Policy[Policy 判断]
  Policy --> Allow{是否允许}
  Allow -->|否| Denied[返回 tool.denied]
  Allow -->|是| Execute[执行 Tool]
  Execute --> Result[生成 ToolResult]
  Result --> DB[写 tool_calls]
  DB --> Trace[写 TraceEvent]
  Trace --> Skill[返回 SkillRunner]
```

## 8. 时序图

```mermaid
sequenceDiagram
  participant Skill as SkillRunner
  participant Registry as ToolRegistry
  participant Policy as Policy
  participant Tool as Tool
  participant Store as SQLite
  participant Trace as TraceRecorder

  Skill->>Registry: execute(toolName, input)
  Registry->>Registry: validate input
  Registry->>Policy: evaluate(tool request)
  Policy-->>Registry: allow
  Registry->>Tool: execute(input, context)
  Tool-->>Registry: ToolResult
  Registry->>Store: insert tool_calls
  Registry->>Trace: tool.completed
  Registry-->>Skill: ToolResult
```

## 9. 类图

```mermaid
classDiagram
  class Tool {
    <<interface>>
    +name: string
    +description: string
    +inputSchema: unknown
    +execute(input, context): Promise~ToolResult~
  }

  class ToolRegistry {
    +register(tool): void
    +get(name): Tool
    +execute(name, input, context): Promise~ToolResult~
  }

  class ToolExecutionContext {
    +sessionId: string
    +turnId: string
    +workspacePath: string
    +policy: Policy
  }

  class ToolResult {
    +toolName: string
    +status: string
    +output: unknown
    +summary: string
    +error: ToolError
  }

  class ListFilesTool
  class ReadFileTool
  class SearchTextTool

  Tool <|.. ListFilesTool
  Tool <|.. ReadFileTool
  Tool <|.. SearchTextTool
  ToolRegistry o-- Tool
  ToolRegistry --> ToolExecutionContext
  ToolRegistry --> ToolResult
```

## 10. 核心数据结构

### 10.1 Tool

```ts
interface Tool {
  name: string;
  description: string;
  inputSchema: unknown;
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolResult>;
}
```

### 10.2 ToolExecutionContext

```ts
interface ToolExecutionContext {
  sessionId: string;
  turnId?: string;
  skillRunId?: string;
  workspacePath: string;
  policy: Policy;
}
```

### 10.3 ToolResult

```ts
interface ToolResult {
  toolName: string;
  status: "completed" | "failed" | "denied";
  output?: unknown;
  summary: string;
  error?: ToolError;
  startedAt: string;
  completedAt: string;
}
```

### 10.4 ToolError

```ts
interface ToolError {
  type: "invalid_input" | "not_found" | "permission_denied" | "execution_failed";
  message: string;
  recoverable: boolean;
}
```

### 10.5 ToolCallRecord

```ts
interface ToolCallRecord {
  id: string;
  sessionId: string;
  turnId?: string;
  skillRunId?: string;
  toolName: string;
  inputSummary: string;
  outputSummary?: string;
  status: "completed" | "failed" | "denied";
  errorMessage?: string;
  startedAt: string;
  completedAt?: string;
}
```

## 11. V1 最小 Tool 集

### 11.1 list_files

职责：

1. 列出工作区文件。
2. 支持限制深度。
3. 支持排除常见目录。

输入：

```ts
interface ListFilesInput {
  root?: string;
  maxDepth: number;
  includeHidden: boolean;
  exclude?: string[];
}
```

输出：

```ts
interface ListFilesOutput {
  root: string;
  files: string[];
  truncated: boolean;
}
```

V1 默认排除：

```text
node_modules
.git
.figo-agent
dist
build
coverage
```

### 11.2 read_file

职责：

1. 读取文本文件。
2. 限制最大读取长度。
3. 返回内容摘要和截断标记。

输入：

```ts
interface ReadFileInput {
  path: string;
  maxChars: number;
}
```

输出：

```ts
interface ReadFileOutput {
  path: string;
  content: string;
  truncated: boolean;
}
```

V1 只读取工作区内文件。

### 11.3 search_text

职责：

1. 在工作区中搜索文本。
2. 返回匹配文件、行号和片段。
3. 限制结果数量。

输入：

```ts
interface SearchTextInput {
  query: string;
  root?: string;
  maxResults: number;
}
```

输出：

```ts
interface SearchTextOutput {
  query: string;
  matches: Array<{
    path: string;
    line: number;
    preview: string;
  }>;
  truncated: boolean;
}
```

## 12. V1 只读边界

V1 Tool 只读。

V1 禁止：

1. 写文件。
2. 删除文件。
3. 执行命令。
4. Git 操作。
5. 网络访问。
6. 浏览器操作。
7. 外部 API 调用。

V1 允许：

1. 列目录。
2. 读文件。
3. 文本搜索。

## 13. Policy 校验

所有 Tool 调用必须经过 Policy。

V1 Policy 结果：

```ts
interface PolicyDecision {
  allowed: boolean;
  reason: string;
}
```

V1 `ReadOnlyPolicy` 规则：

1. Tool 必须在 V1 允许列表中。
2. 文件路径必须在 workspacePath 内。
3. 读取长度必须在限制内。
4. 搜索结果数量必须在限制内。
5. 禁止写操作和命令操作。

## 14. SQLite 记录

V1 写入 `tool_calls` 表：

```sql
CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  turn_id TEXT,
  skill_run_id TEXT,
  tool_name TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  output_summary TEXT,
  status TEXT NOT NULL,
  error_message TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
```

Tool 输入输出不把大内容全量写入摘要字段。大内容进入 Artifact 或 Trace payload 的受控摘要。

## 15. TraceEvent 设计

Tool 模块必须记录：

1. `tool.called`
2. `tool.completed`
3. `tool.failed`
4. `tool.denied`

TraceEvent payload 必须包含：

1. toolName。
2. sessionId。
3. turnId。
4. skillRunId。
5. inputSummary。
6. outputSummary。
7. errorMessage。
8. duration。

## 16. ToolResult 进入 Context 的规则

V1 ToolResult 默认不回灌模型。

ToolResult 进入：

1. Trace。
2. SQLite。
3. Reporter。
4. SkillRunResult。

ToolResult 进入 ContextPack 的条件：

1. ContextBuilder 明确选择。
2. 结果经过摘要。
3. 结果与当前 Turn 强相关。

这个规则用于控制 token 膨胀。

## 17. 与 AgentLoop 的关系

AgentLoop 不直接调用具体 Tool。

```text
AgentLoop
  -> SkillRunner
  -> ToolRegistry
  -> Tool
```

AgentLoop 只接收 SkillRunResult 和 ToolResult 摘要。

## 18. 与 Skill 的关系

Skill 通过 `allowedTools` 声明可用 Tool。

ToolRegistry 执行时必须检查：

1. Tool 是否存在。
2. Tool 是否在 SkillManifest.allowedTools 中。
3. Policy 是否允许。

## 19. 与 Trace 的关系

Tool 是风险和事实的交汇点。每次 Tool 调用都必须有迹可循。

V1 要能回答：

1. 哪个 Skill 调用了 Tool。
2. 调用了哪个 Tool。
3. 输入摘要是什么。
4. 输出摘要是什么。
5. 是否失败。
6. 失败原因是什么。
7. 耗时是多少。

## 20. 失败处理矩阵

| 失败位置 | 失败原因 | V1 行为 | TraceEvent |
| :--- | :--- | :--- | :--- |
| ToolRegistry | Tool 不存在 | 返回 ToolError | `tool.failed` |
| 输入校验 | 参数错误 | 返回 ToolError | `tool.failed` |
| Policy | 权限拒绝 | 不执行 Tool | `tool.denied` |
| list_files | 目录不存在 | 返回 ToolError | `tool.failed` |
| read_file | 文件不存在 | 返回 ToolError | `tool.failed` |
| search_text | 搜索异常 | 返回 ToolError | `tool.failed` |

## 21. V1 实现范围

V1 实现：

1. Tool 接口。
2. ToolRegistry。
3. ToolExecutionContext。
4. ToolResult。
5. ToolError。
6. `list_files`。
7. `read_file`。
8. `search_text`。
9. tool_calls 表写入。
10. Tool 相关 TraceEvent。

V1 不实现：

1. `apply_patch`。
2. `run_command`。
3. Git 工具。
4. 浏览器工具。
5. 外部 API 工具。
6. 网络访问工具。
7. MCP 工具。

## 22. V1.2 受控执行 Tool 设计

V1.2 的目标是补齐验证闭环所需的 Tool 能力。它从 V1 的只读观察升级为受控执行：能查本机配置、读写工作区文件、执行 shell、执行 Git 写操作、访问网络、操作浏览器。

V1.2 的安全基线不是“禁止高风险能力”，而是“高风险能力必须受控”。所有 Tool 必须经过 Policy，所有结果必须结构化，所有调用必须写 Trace 和 `tool_calls`。

### 22.1 V1.2 能力边界

V1.2 新增 Tool：

| Tool | 定位 | 权限等级 | 说明 |
| --- | --- | --- | --- |
| `system_info` | 查询本机基础配置 | read-only-system | 固定白名单，不执行任意命令 |
| `path_stat` | 查询工作区内路径元信息 | read-only-workspace | 用于判断文件、目录、大小和修改时间 |
| `read_many_files` | 批量读取小文件 | read-only-workspace | 用于减少多次 Tool 调用 |
| `workspace_summary` | 汇总工作区状态 | read-only-workspace | 读取 package、脚本、关键配置存在性 |
| `write_file` | 写入工作区文件 | write-workspace | 支持新建、覆盖和创建父目录 |
| `apply_patch` | 应用结构化补丁 | write-workspace | 保存 patch 摘要和结果 |
| `run_command` | 执行 shell 命令 | command | 支持测试、lint、build 和本地排查 |
| `git_status` | 查看 Git 状态 | git-read | 不修改仓库 |
| `git_diff` | 查看 Git 差异 | git-read | 支持路径过滤 |
| `git_log` | 查看 Git 日志 | git-read | 支持数量限制 |
| `git_add` | 暂存文件 | git-write | 只允许工作区内路径 |
| `git_commit` | 创建提交 | git-write | 必须有 commit message |
| `network_fetch` | 受控 HTTP 请求 | network | 限制方法、超时、响应大小 |
| `browser_open` | 打开浏览器页面 | browser | 记录 URL 和标题 |
| `browser_snapshot` | 读取页面状态 | browser | 返回标题、URL 和文本摘要 |

### 22.2 system_info

`system_info` 解决“当前 agent 为什么不能查询本机配置”的问题。它不依赖 `run_command`，而是固定读取白名单字段。

输入：

```ts
interface SystemInfoInput {
  includeEnvironment?: false;
}
```

输出：

```ts
interface SystemInfoOutput {
  platform: string;
  release: string;
  arch: string;
  cpuCount: number;
  totalMemoryBytes: number;
  nodeVersion: string;
  workspaceRoot: string;
  shellName?: string;
}
```

约束：

1. 不返回完整环境变量。
2. 不返回 API Key、token、secret、password。
3. 不通过 shell 查询系统信息。
4. 输出进入 `tool_calls` 和 Trace 摘要。

### 22.3 path_stat

`path_stat` 用于在读取前判断路径状态。

输入：

```ts
interface PathStatInput {
  path: string;
}
```

输出：

```ts
interface PathStatOutput {
  path: string;
  exists: boolean;
  type?: "file" | "directory" | "other";
  sizeBytes?: number;
  modifiedAt?: string;
}
```

约束：

1. 只允许工作区内路径。
2. 路径越界返回 `path_outside_workspace`。
3. 不读取文件正文。

### 22.4 read_many_files

`read_many_files` 用于批量读取小文件，减少多轮 Tool 调用。

输入：

```ts
interface ReadManyFilesInput {
  paths: string[];
  maxBytesPerFile?: number;
  maxTotalBytes?: number;
}
```

输出：

```ts
interface ReadManyFilesOutput {
  files: Array<{
    path: string;
    status: "completed" | "failed" | "skipped";
    content?: string;
    bytes?: number;
    errorCode?: string;
    errorMessage?: string;
  }>;
  truncated: boolean;
}
```

默认限制：

1. 单文件最大 64KB。
2. 总读取最大 256KB。
3. 单次最多 20 个文件。

### 22.5 workspace_summary

`workspace_summary` 用于快速理解当前项目的工程入口。

输出：

```ts
interface WorkspaceSummaryOutput {
  root: string;
  packageManager?: "npm" | "pnpm" | "yarn" | "unknown";
  packageName?: string;
  scripts: Record<string, string>;
  hasGit: boolean;
  keyFiles: Array<{ path: string; exists: boolean }>;
}
```

它只读取固定文件：

1. `package.json`
2. `tsconfig.json`
3. `AGENTS.MD`
4. `readme.md`
5. `.git`
6. lockfile：`package-lock.json`、`pnpm-lock.yaml`、`yarn.lock`

### 22.6 V1.2 Policy 调整

V1.2 将 `ReadOnlyPolicy` 升级为 `ControlledToolPolicy`。策略要区分 read、write、command、git、network、browser 六类能力。

允许动作：

```text
tool.list_files
tool.read_file
tool.search_text
tool.system_info
tool.path_stat
tool.read_many_files
tool.workspace_summary
tool.write_file
tool.apply_patch
tool.run_command
tool.git_status
tool.git_diff
tool.git_log
tool.git_add
tool.git_commit
tool.network_fetch
tool.browser_open
tool.browser_snapshot
```

受控规则：

1. workspace 类 Tool 只能访问工作区内路径。
2. `write_file` 和 `apply_patch` 必须记录写入路径、字节数和内容 hash。
3. `run_command` 必须限制 cwd 在工作区内，必须设置 timeout、maxOutputBytes 和环境变量脱敏。
4. `run_command` 必须返回 exitCode、stdout 摘要、stderr 摘要、durationMs。
5. Git 写操作必须记录命令、路径、diff 摘要和 commit message。
6. `network_fetch` 只允许 `GET`、`POST`，必须限制响应大小和超时。
7. 网络 headers 中的 Authorization、API Key、token、secret、password 必须脱敏。
8. 浏览器 Tool 必须记录 URL、标题和页面摘要，不保存敏感输入。
9. 危险命令和破坏性路径操作必须返回 `action_not_supported`。

危险命令拦截清单：

```text
rm -rf /
rm -rf .
sudo
chmod -R 777
mkfs
dd
shutdown
reboot
```

### 22.7 V1.2 流程图

```mermaid
flowchart TD
  Skill[SkillRunner] --> Registry[ToolRegistry]
  Registry --> Policy[ControlledToolPolicy V1.2]
  Policy --> Allowed{允许?}
  Allowed -->|否| Denied[tool.denied]
  Allowed -->|是| Tool{Tool 类型}
  Tool --> Read[只读观察 Tool]
  Tool --> Write[写文件 / patch Tool]
  Tool --> Command[run_command]
  Tool --> Git[Git Tool]
  Tool --> Network[network_fetch]
  Tool --> Browser[browser_open / browser_snapshot]
  Read --> Result[ToolResult]
  Write --> Result
  Command --> Result
  Git --> Result
  Network --> Result
  Browser --> Result
  Result --> Trace[tool.completed / tool.failed]
```

### 22.8 V1.2 验收标准

必须通过：

1. `system_info` 返回固定白名单系统信息。
2. `system_info` 不返回密钥类环境变量。
3. `path_stat` 能识别文件、目录、不存在路径。
4. `path_stat` 拒绝工作区外路径。
5. `read_many_files` 能批量读取多个工作区内文件。
6. `read_many_files` 遵守单文件、总大小和文件数量限制。
7. `workspace_summary` 能读取 package scripts 和关键文件存在性。
8. `write_file` 能写入工作区内文件，并拒绝工作区外路径。
9. `apply_patch` 能应用结构化补丁，并记录 patch 摘要。
10. `run_command` 能执行测试、lint、build 命令，并返回 exitCode、stdout、stderr、durationMs。
11. `run_command` 拒绝危险命令。
12. `git_status`、`git_diff`、`git_log` 能读取 Git 信息。
13. `git_add`、`git_commit` 能执行 Git 写操作，并记录 diff 摘要和 commit message。
14. `network_fetch` 能执行受控 HTTP 请求，并对 headers 脱敏。
15. `browser_open`、`browser_snapshot` 能打开页面并读取页面摘要。
16. 所有新增 Tool 都经过 Policy。
17. 所有新增 Tool 都写 `tool.called`、`tool.completed`、`tool.failed` 或 `tool.denied`。

禁止放行：

1. Tool 绕过 Policy。
2. Tool 绕过 Trace。
3. Tool 读取或写入工作区外文件。
4. `run_command` 没有 timeout。
5. `run_command` 没有输出截断。
6. 网络 Tool 记录明文密钥。
7. 浏览器 Tool 记录敏感输入。
8. Git 写操作没有 diff 摘要。

## 23. V2/V3 扩展点

V2：

1. Tool dry-run。
2. Tool 风险评分。
3. Tool 调用回放。
4. Tool 失败归因。
5. 项目级 Policy profile。
6. Verifier 对 Tool 结果做自动验收。
7. Goal 维度的 Tool 调用预算。

V3：

1. 浏览器工具。
2. 外部 API 工具。
3. MCP 工具。
4. Tool 插件目录。
5. Tool 执行统计。
6. Tool 风险评分。

## 24. 可沉淀的文章观点

1. Tool 是 agent 接触外部世界的接口，必须小而可控。
2. Tool 越原子，Skill 组合越灵活。
3. 只读 Tool 是 V1 最稳的起点。
4. ToolResult 不默认回灌模型，是控制 token 和上下文污染的关键。
5. Tool 必须经过 Policy，否则 agent 的能力边界不可控。

## 25. 个人经验提炼

Tool 模块最容易犯三个错误：

1. 把多个动作塞进一个 Tool。
2. 让 Tool 直接写最终报告。
3. 绕过 Policy 执行高风险动作。

V1 要避免这些问题：

1. 每个 Tool 只做一个动作。
2. ToolResult 结构化。
3. Tool 调用必须写 Trace。
4. Tool 执行必须经过 Policy。
5. 写操作和命令操作延后到 V2。

这就是从“脚本能力”走向“agent 工具系统”的关键。
