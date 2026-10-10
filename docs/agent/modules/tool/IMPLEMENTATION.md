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
