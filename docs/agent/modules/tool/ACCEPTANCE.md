# Tool 测试验收

## 2026-10-16 参数契约修复验收

`write_file` 参数契约补齐已通过自动化验收：定向 3 文件 93 项、全量 75 文件 721 项全部通过，类型检查与构建通过。新增 7 项测试，修复前其中 4 项按预期失败，修复后全部通过。完整根因、证据和禁止放行条件见 [专项验收](./2026-10-16-write_file参数契约修复验收.md)。本轮没有执行真实模型复测，不将自动化通过等同于模型每次都能正确选择参数。下文只读限制仅对应历史 V1，写入能力按 V1.2 和专项验收执行。

## 放行规则

以下验收全部通过才允许放行。任意一项失败，禁止进入下一阶段。

## 自动化测试

```bash
npm test -- tests/tools/read-only-tools.test.ts
npm run typecheck
```

## 必须通过

1. `list_files` 列出工作区文件。
2. `list_files` 排除 `.git`、`node_modules`、`.figo-agent`、`dist`、`build`、`coverage`。
3. `read_file` 能读取工作区内文件。
4. `read_file` 拒绝工作区外路径。
5. `search_text` 能返回匹配行。
6. ToolRegistry 找不到 Tool 时返回 ToolError。
7. Policy 拒绝时不执行 Tool。

## Trace 验收

必须支持：

```text
tool.called
tool.completed
tool.failed
tool.denied
```

## 禁止放行条件

1. Tool 绕过 Policy。
2. Tool 写文件。
3. Tool 执行 shell 命令。
4. Tool 读取工作区外路径。

## V1.2 测试验收

## 自动化测试

```bash
npm test -- --run tests/policy/controlled-tool-policy.test.ts tests/tools/read-only-tools.test.ts tests/tools/write-tools.test.ts tests/tools/command-tools.test.ts tests/tools/git-tools.test.ts tests/tools/network-browser-tools.test.ts
npm test
npm run typecheck
npm run build
```

## 必须通过

1. `system_info` 返回平台、系统版本、CPU 核心数、内存、Node 版本、工作区路径。
2. `system_info` 不返回 API Key、token、secret、password。
3. `path_stat` 能返回文件、目录、不存在路径。
4. `path_stat` 拒绝工作区外路径。
5. `read_many_files` 能批量读取工作区内文件。
6. `read_many_files` 对单文件大小、总大小、文件数量做限制。
7. `workspace_summary` 能返回 package scripts、lockfile 和关键文件存在性。
8. `write_file` 能写入工作区内文件，并拒绝工作区外路径。
9. `apply_patch` 能应用结构化补丁，并记录 patch 摘要。
10. `run_command` 能执行测试、lint、build 命令，并返回 exitCode、stdout、stderr、durationMs。
11. `run_command` 拒绝危险命令。
12. `git_status`、`git_diff`、`git_log` 能读取 Git 信息。
13. `git_add`、`git_commit` 能执行 Git 写操作，并记录 diff 摘要和 commit message。
14. `network_fetch` 能执行受控 HTTP 请求，并对 headers 脱敏。
15. `browser_open`、`browser_snapshot` 能打开页面并读取页面摘要。
16. V1.2 新增 Tool 全部经过 Policy。

## 禁止放行条件

1. 新增 Tool 绕过 ToolRegistry。
2. 新增 Tool 绕过 Policy。
3. 新增 Tool 返回完整环境变量。
4. 新增 Tool 读取或写入工作区外文件。
5. `run_command` 没有 timeout。
6. `run_command` 没有输出截断。
7. 网络 Tool 记录明文密钥。
8. 浏览器 Tool 记录敏感输入。
