# Tool 测试验收

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
