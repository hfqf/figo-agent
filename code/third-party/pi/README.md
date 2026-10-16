# Pi 压缩算法来源与宿主适配

## 固定来源

- 上游项目：[earendil-works/pi](https://github.com/earendil-works/pi)。
- 固定提交：`6a1f799b675c8cb98320b71ff7ee44f160fe8d66`。
- 主要源码：[packages/coding-agent/src/core/compaction/compaction.ts](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/compaction/compaction.ts)。
- 摘要序列化与文件列表参考：[packages/coding-agent/src/core/compaction/utils.ts](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/compaction/utils.ts)。
- 条目转换参考：[packages/coding-agent/src/core/session-manager.ts](https://github.com/earendil-works/pi/blob/6a1f799b675c8cb98320b71ff7ee44f160fe8d66/packages/coding-agent/src/core/session-manager.ts)。
- MIT 许可证，Copyright (c) 2025 Mario Zechner；完整原文见 [LICENSE](./LICENSE)。
- 纯算法移植产物：`code/src/context/pi-compaction.ts`。
- 独立摘要宿主适配：`code/src/context/pi-summary.ts`。
- 专属中文提示资源：`code/locales/pi-summary.zh-CN.json`；不修改主 catalog，也不从开发文档读取提示词。

## 直接保留的算法

`calculateContextTokens`、`getAssistantUsage`、`getLastAssistantUsageInfo`、`estimateContextTokens`、`shouldCompact`、`estimateTextAndImageContentChars`、`estimateTokens`、`isCutPointMessage`、`isTurnStartMessage`、`isTurnStartEntry`、`findValidCutPoints`、`findTurnStartIndex`、`findCutPoint`、`isProjectedTurnStart`、`findProjectedTurnStartIndex`、`findProjectedCutPoint` 保留固定上游函数体。类型名称替换与新增导出不改变运行算法。

触发条件仍为严格大于 `contextWindow - reserveTokens`。近期保留反向累计达到 `keepRecentTokens` 即停止，零 token 项跳过；工具结果不能作为切点。超大工具尾部回退到最近合法 assistant 切点，metadata 回扫、Turn 起点查找和拆分判定均保留。

投影切点保留恢复省略后缀逻辑：达到预算、后缀包含省略的 assistant、没有后缀外目标的非空替换、后缀闭合且不含 compaction 时前移一项，再执行原有回扫。仅有 metadata 或省略用户消息不能触发前移；判断限定在传入的排他 `endIndex` 内。

## 明确的宿主适配差异

1. 上游依赖类型替换为最小 `PiUsage`、`PiMessage`、`PiSessionEntry`、`PiProjectedEntry`；不引入 Pi 运行时、Provider、SessionManager 或扩展系统。
2. `sessionEntryToContextMessages` 是本项目适配：`message` 返回原消息一项；有 `summary` 的 `compaction` 返回包含原摘要文本的 `compactionSummary`，缺省摘要返回空；`metadata` 与 `context_edit` 返回空。与完整上游相比，不处理旧会话空 content 修复、自定义条目转换、摘要包装或 systemMessage 回放。这些内容必须由宿主转换到约定消息类型。
3. `context_edit` 不在这里执行。`PiProjectedEntry.messages` 由调用方提供，必须已经反映实际替换、省略和可见性。投影可贡献零条、一条或多条消息，返回索引始终指向传入投影数组。
4. `findProjectedCutPoint` 从上游私有函数改为导出，供独立 preparation 模块使用；输入 `startIndex/endIndex` 由调用方提供有效区间。
5. 配置类型来自 `pi-compaction-settings.ts`，只取 `enabled/reserveTokens/keepRecentTokens`。默认值和校验由该配置模块负责，不复制第二套配置。
6. 纯算法文件不承载 `prepareCompaction`、投影构造、模型选择、Store/Loop、摘要请求、超限重试或文件操作编排。`estimateContextTokens` 接收已经选定的有效消息；跨模型或投影变化后的 usage 是否可复用由宿主判断，不在本函数添加策略。独立摘要模块的适配范围见下节。

本次未改变上述纯函数的运行算法。条目适配限定了可处理的输入范围，不能把最小宿主适配称为完整 Pi SessionManager。

## 独立摘要与中文资源适配

`generatePiSummary(llm, input)` 接受宿主 `ConversationMessage`，只生成摘要与文件操作列表，不决定切点、不执行工具、不写存储。其输入、输出分别由 `PiSummaryInput`、`PiSummaryResult` 声明。

1. 调用顺序参考上游 `generateSummaryWithUsage`、`generateTurnPrefixSummary` 与 `compact`。普通历史摘要输出预算为 `floor(0.8 * reserveTokens)`，split 前缀为 `floor(0.5 * reserveTokens)`，模型提供正数 `maxTokens` 时分别夹紧。只有前缀时复用旧摘要；两部分按上游分隔符和 `Turn Context (split turn)` 标记合并。
2. 中文资源翻译并保留 Pi 的六类英文段落标题及 Progress 三个子标题。split 前缀保留 Original Request、Progress So Far、Context Needed to Continue。摘要正文明确要求中文；初始、滚动更新、前缀提示、序列化角色标签和截断提示全部来自专属 JSON。
3. `serializeConversation` 直接参考固定 `utils.ts` 的顺序和格式：用户正文、助手可见正文、工具名与 JSON 参数、工具结果转换成文本。宿主适配将原生工具协议和文本工具协议转换为 `PiMessage`；助手内联思考块先剥离，未闭合思考尾部不进入摘要输入，用户与工具返回的字面文本保留。
4. 上游工具结果预览常量 2000 改为配置输入 `summaryToolResultMaxChars`，默认仍由配置模块提供 2000；截断标记中文化并包含省略字符数。只截断摘要请求中的预览，不修改原始消息与调用方保留的工具 batch。
5. 文件列表参考 `extractFileOpsFromMessage`、`computeFileLists`、`formatFileOperations`。除上游 read/write/edit 外，适配 read_file、read_many_files.paths、write_file、edit_file 和 apply_patch.patches[].path。`previousReadFiles/previousModifiedFiles` 与当前 history/prefix 的调用记录合并后统一去重、排序；修改记录优先于只读记录，程序直接追加 XML 尾部，不依赖模型复述旧列表。该列表描述工具调用涉及的文件，不独立证明写操作执行成功。
6. 所有摘要请求使用选定的 `LLMProvider` 和模型，`purpose=task_compaction`，携带 session/task/turn、独立 requestId、signal 和输出预算，不声明 tools，不传流式回调。`requestIds` 保留调用顺序，`requestId` 指向最后一次请求；仅当全部已发请求返回 usage 时聚合，任一未知则聚合 usage 保持未知，原始用量仍可按请求抓包查询。
7. 校验限于剥离思考后的空内容、length、error 和工具调用响应，取消和 Provider 异常直接失败。不增加 JSON 输出、段落 schema 或来源复述校验；正文语言和格式由提示约束，不宣称已通过语义验证。与上游运行时相比，本模块不包含重试、缓存路由或会话树操作，Store/Loop 由主模块衔接。

## 验证范围

`code/tests/context/pi-compaction-conformance.test.ts` 使用固定上游行为的边界样例，覆盖 usage 缺省、全零、error/aborted、分量回退、字符估算与工具参数、严格阈值、近期预算边界、超大工具尾部、单用户拆分、metadata、投影多消息和恢复省略后缀。测试中的宿主条目映射单独分组，不将其视为完整上游投影的验证。

`code/tests/context/round-compaction.test.ts` 验证独立摘要模块的预算、滚动更新与 split 合并、原始目标、原生多工具 batch 全文、文本协议、思考剥离、工具预览、历史文件列表累计、usage 未知、取消及异常。它替代旧轮内 JSON 摘要测试，保留其目标与工具安全的验收意图。

```bash
npm --prefix code test -- tests/context/pi-compaction-conformance.test.ts tests/context/round-compaction.test.ts
npm --prefix code run typecheck
```

这些检查证明纯算法与约定输入的行为，不证明摘要语义无损、token 估算精确或完整业务编排已验收。
