# Tool 实施计划

## 目标

实现 V1 只读 Tool 集和 ToolRegistry，确保所有 Tool 调用经过 Policy。

## 文件

- `src/tools/read-only-tools.ts`
- `src/tools/tool-registry.ts`
- `tests/tools/read-only-tools.test.ts`

## 实施步骤

1. 实现 `list_files`。
2. 实现 `read_file`。
3. 实现 `search_text`。
4. 实现 ToolRegistry。
5. ToolRegistry 根据工具名查找 Tool。
6. ToolRegistry 构造 PolicyRequest。
7. Policy 允许后执行 Tool。
8. Policy 拒绝后返回 ToolError。
9. Tool 调用写入 `tool.called`。
10. Tool 成功写入 `tool.completed`。
11. Tool 失败写入 `tool.failed`。
12. Tool 被拒绝写入 `tool.denied`。

## 依赖

- ReadOnlyPolicy。
- TraceRecorder。
- StorageManager。

## 不做

- 不写文件。
- 不执行命令。
- 不执行 Git。
- 不访问网络。
- 不访问浏览器。

## V1.2 实施计划

## 目标

补齐受控执行 Tool 能力，让 agent 能查询本机基础配置、读写工作区文件、应用补丁、执行验证命令、操作 Git、访问网络和浏览器。

## 文件

- `src/contracts/types.ts`
- `src/tools/read-only-tools.ts`
- `src/tools/write-tools.ts`
- `src/tools/command-tools.ts`
- `src/tools/git-tools.ts`
- `src/tools/network-tools.ts`
- `src/tools/browser-tools.ts`
- `src/tools/tool-registry.ts`
- `src/policy/read-only-policy.ts`
- `src/policy/controlled-tool-policy.ts`
- `tests/tools/read-only-tools.test.ts`
- `tests/tools/write-tools.test.ts`
- `tests/tools/command-tools.test.ts`
- `tests/tools/git-tools.test.ts`
- `tests/tools/network-browser-tools.test.ts`
- `tests/policy/read-only-policy.test.ts`
- `tests/policy/controlled-tool-policy.test.ts`

## 实施步骤

1. 扩展 `PolicyAction`，增加 V1.2 全量 Tool action。
2. 新增 `ControlledToolPolicy`。
3. 实现 `system_info` Tool。
4. 实现 `path_stat` Tool。
5. 实现 `read_many_files` Tool。
6. 实现 `workspace_summary` Tool。
7. 实现 `write_file` Tool。
8. 实现 `apply_patch` Tool。
9. 实现 `run_command` Tool。
10. 实现 `git_status`、`git_diff`、`git_log`、`git_add`、`git_commit` Tool。
11. 实现 `network_fetch` Tool。
12. 实现 `browser_open`、`browser_snapshot` Tool。
13. 更新 `toolAction()` 映射。
14. 更新内置 Tool 注册列表。
15. 补齐新增 Tool 测试。
16. 补齐 Policy 允许、拒绝、危险命令拦截测试。
17. 跑 `npm test -- tests/tools/read-only-tools.test.ts tests/tools/write-tools.test.ts tests/tools/command-tools.test.ts tests/tools/git-tools.test.ts tests/tools/network-tools.test.ts tests/tools/browser-tools.test.ts tests/policy/controlled-tool-policy.test.ts`。
18. 跑 `npm run typecheck`。
19. 跑 `npm run build`。

## V1.2 当前实现状态

已完成：

1. `ControlledToolPolicy`：集中管理 V1.2 受控能力白名单、工作区边界、cwd 边界、危险命令拦截、URL 协议限制。
2. 观察类 Tool：`system_info`、`path_stat`、`read_many_files`、`workspace_summary`。
3. 写入类 Tool：`write_file`、`apply_patch`。
4. 命令类 Tool：`run_command`，包含 timeout、输出截断、危险命令二次防护。
5. Git Tool：`git_status`、`git_diff`、`git_log`、`git_add`、`git_commit`。
6. 网络 Tool：`network_fetch`，限制 http/https，响应 headers 脱敏，响应体截断。
7. 浏览器 Tool：`browser_open`、`browser_snapshot`，第一版以 HTTP 拉取和 HTML 文本快照实现。
8. `ToolRegistry`：完成 V1.2 工具名到 `PolicyAction` 的精确映射，并把路径、cwd、URL、命令传入 Policy。
9. 内置插件：默认注册完整 V1.2 Tool 集。

验收命令：

```bash
npm test -- --run tests/policy/controlled-tool-policy.test.ts tests/tools/read-only-tools.test.ts tests/tools/write-tools.test.ts tests/tools/command-tools.test.ts tests/tools/git-tools.test.ts tests/tools/network-browser-tools.test.ts
npm test
npm run typecheck
npm run build
```

## V1.2 风险控制

- 不允许 Tool 绕过 Policy。
- 不允许 Tool 绕过 Trace。
- 不允许读写工作区外文件。
- 不允许 `run_command` 无 timeout。
- 不允许 `run_command` 无输出截断。
- 不允许网络 Tool 记录明文密钥。
- 不允许浏览器 Tool 记录敏感输入。
