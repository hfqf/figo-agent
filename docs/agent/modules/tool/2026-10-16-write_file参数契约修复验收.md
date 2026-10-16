# write_file 参数契约修复验收

## 背景与直接证据

工作台实际任务 `task_51ff2905-e587-456f-bd5a-6e154f1a15c1` 的 Turn 4 为 `turn_4aba92cf-c7c5-40d3-a75d-dafcc772c4a6`。证据来自工作区 SQLite `tool_calls`、`trace_events`、`llm_http_captures`，时间均为上海时间。

| 时间 | 节点 | 结果 |
| :--- | :--- | :--- |
| 09:33:56 | `path_stat(商业化分析)` | `kind=missing` |
| 09:34:19 | `write_file(商业化分析/README.md)` | 未传 `createDirs`，父目录不存在，`ENOENT` |
| 09:34:59 | `run_command(mkdir -p '商业化分析')` | `exitCode=0` |
| 09:38:11 | 再次写入 README 和分析文档 | 两次均 `completed` |
| 09:38:42 | Turn 结束 | `completed` |

失败工具调用 ID 为 `tool_call_eb2f096f-4e63-433a-a994-bf3c68c23078`。失败前请求 `llm_req_e554f3bf-94be-44ac-8183-40a749cba615` 中，`write_file` 的参数定义为 `{"type":"object","properties":{},"additionalProperties":true}`。下一次请求携带了与原调用 ID 配对的失败反馈，模型随后补建目录，证明本次错误传递与继续执行链路有效。

执行器本来就支持 `createDirs === true` 时递归创建父目录，但工具没有声明 `inputSchema`，描述也未说明这个参数。根因是工具契约缺失，不是压缩、权限或 HTTP 失败。不能从这一次日志推导补齐 Schema 后所有模型都不会再漏参。

## 修复范围

1. `write_file.inputSchema` 声明 `path` 为非空字符串、`content` 为字符串，两者必填；`createDirs` 为可选布尔值，默认 `false`，`additionalProperties=false`。
2. 中文工具描述及字段说明统一存入 `code/locales/zh-CN.json`，通过已有 `zhCN` 类型化资源读取。
3. 文本提示词和原生请求复用 ToolRegistry 的声明，不另造参数副本，不修改 Provider 的通用映射。
4. 不修改执行器：显式 `true` 才创建父目录；省略或 `false` 不创建；已有文件仍覆盖，空内容仍允许；Policy 和工作区边界不变。
5. Schema 是模型侧参数声明，不新增本地通用 Schema 校验器，不将声明描述成已经覆盖所有运行时输入验证。

用法：

```json
{
  "path": "商业化分析/README.md",
  "content": "# 商业化分析\n",
  "createDirs": true
}
```

## 测试与放行

### 红绿回归

新增 7 项测试：工具声明 1 项、缺失父目录且省略/关闭创建 2 项、覆盖为空内容 1 项、文本提示词 1 项、原生流式/非流式请求 2 项。

| 验收节点 | 修复前 | 修复后 |
| :--- | :--- | :--- |
| 注册表包含参数 Schema 和目录创建说明 | 失败，Schema 为 `undefined` | 通过 |
| 文本协议包含实际工具 Schema | 失败，Schema 为 `undefined` | 通过 |
| 原生非流式请求包含三个参数 | 失败，发送空 `properties` | 通过 |
| 原生流式请求包含三个参数 | 失败，发送空 `properties` | 通过 |
| 省略/关闭创建时仍报父目录缺失 | 通过 | 通过 |
| 显式创建父目录、覆盖文件、空内容及越界拒绝 | 通过 | 通过 |

命令在 `code/` 下执行：

```bash
npx vitest run tests/tools/write-tools.test.ts tests/loop/llm-message-builder.test.ts tests/llm/openai-compatible-provider.test.ts
npm test
npm run typecheck
npm run build
git diff --check
```

实际结果：

- 修复前定向：4 项失败、89 项通过，失败均指向声明缺失。
- 修复后定向：3 文件、93 项全部通过。
- 全量回归：75 文件、721 项全部通过。
- 类型检查、构建、差异空白检查：退出码均为 0。
- 确认无运行中 Run 或终端命令后已重启本地 4322 工作台，新进程启动正常，`/api/v1/bootstrap` 返回 HTTP 200；后续请求使用更新后的工具声明。该检查不代表真实模型复测。
- 本轮没有执行真实 GPT、MiniMax 或 DeepSeek 复测，不将本地传输断言计作真实模型验收。

以下任一情况出现，禁止放行本修复：

1. 工具仍向模型发送空参数定义，或文本协议无法看到 `createDirs`。
2. 未显式开启创建目录却自动创建父目录。
3. 原有覆盖、空内容或工作区外路径拒绝行为发生回归。
4. 中文工具说明重新硬编码进运行参数配置或开发文档成为执行依赖。
5. 定向测试、全量回归、类型检查、构建中任一项失败。

## 可复用经验

工具的执行能力、模型可见的契约、实际请求中的 Schema 必须对应。只有执行器单测通过，不能证明模型知道如何使用参数；应从真实注册工具出发，验证它在文本与原生请求中的最终形态。模型收到错误后能自行修复，证明恢复有效，不代表第一次失败没有改进价值。
