import { createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  TraceInspectorDetail,
  TraceInspectorEventRow,
} from "../../src/contracts/trace-inspector.js";
import {
  inspectorReducer,
  initialInspectorState,
  detailPath,
  listPath,
  reduction,
  redact,
  exportEvidence,
  decodeLayout,
  canAppendPage,
  InspectorRequestGate,
  fileReferencePath,
  snapshotDifference,
  matchesCategory,
  durationText,
  inspectorFieldPath,
  defaultRequestId,
} from "../../web/src/trace-inspector-state.js";
import { TraceInspectorDetails } from "../../web/src/TraceInspectorDetails.js";
import { TraceInspectorSource } from "../../web/src/TraceInspectorSource.js";
import { TraceInspector } from "../../web/src/TraceInspector.js";
import { Facts, JsonView } from "../../web/src/TraceInspectorPrimitives.js";

const row = (key: string, requestId?: string): TraceInspectorEventRow => ({
  key,
  category: "capture",
  time: "2026-10-16 12:00:00.001",
  kind: "llm.completed",
  status: "ok",
  sessionId: "s",
  taskId: "t",
  turnId: "turn",
  turnSeq: 1,
  source: "LLMProvider",
  name: key,
  durationMs: 10,
  tokens: null,
  refs: { requestId },
});
const detail = (): TraceInspectorDetail => ({
  row: row("capture:one", "old"),
  record: {},
  events: [],
  context: { pack: null, items: [], checkpoint: null },
  tools: [],
  messages: [],
  compactions: [],
  legacyCheckpoints: [],
  artifacts: [],
  selection: {
    taskId: "t",
    turnId: "turn",
    requestId: "old",
    requestAssociation: "direct",
    compactionEntryId: null,
    compactionAttemptId: null,
    recoveryOfRequestId: null,
    contextPackId: null,
    projection: {
      status: "unknown",
      compactionEntryId: null,
      sourceRefs: [],
      usageScope: null,
    },
  },
  limitations: ["历史关联未确认"],
  truncated: false,
  captures: ["old", "new"].map((id) => ({
    id,
    requestId: id,
    taskId: "t",
    turnId: "turn",
    purpose: "dialogue",
    provider: "test",
    model: "test",
    url: "https://example.test",
    method: "POST",
    requestHeaders: { Authorization: "secret-value" },
    requestBody: {
      messages: [
        { role: "user", content: id === "old" ? "历史原文" : "最新摘要" },
      ],
    },
    responseStatus: 200,
    responseStatusText: "OK",
    responseHeaders: {},
    responseBody: {
      choices: [
        {
          message: {
            content: "读取过程说明",
            tool_calls: [{ id: "call-1", function: { name: "read_file" } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    durationMs: 12,
    createdAt: "2026-10-16 12:00:00.001",
    usage: {
      status: "unavailable",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageTurnId: null,
    },
    relation: "direct",
  })),
});

function fieldPreview(field = "request_body_json", path: Array<string | number> = ["messages", 0, "content"], eventKey = "capture:one"): import("../../web/src/trace-inspector-state.js").InspectorField {
  return { __inspectorField: true, eventKey, field, path, originalChars: 50000, preview: "脱敏正文预览", loadable: true };
}
function detailProps(data: TraceInspectorDetail, tab: import("../../web/src/trace-inspector-state.js").InspectorTab) {
  return { detail: data, tab, requestId: "old", compactionEntryId: null,
    onRequest: () => {}, onCompaction: () => {}, onSource: () => {}, onTool: () => {}, onOpenFile: () => {}, onOpenTurn: () => {} };
}

describe("Trace Inspector 前端行为", () => {
  it("模型标签默认选当前详情的第一条请求，不修改事件关联证据", () => {
    const data = detail();
    data.selection.requestId = null;
    data.selection.requestAssociation = "unknown";
    expect(defaultRequestId(data, null)).toBe("old");
    expect(data.selection.requestAssociation).toBe("unknown");
    expect(defaultRequestId(data, "new")).toBe("new");
  });
  it("明确引用和手动选择缺失抓包时不静默改选其他请求，空集合不编造默认", () => {
    const data = detail();
    data.selection.requestId = "not-yet-recorded";
    expect(defaultRequestId(data, null)).toBe("not-yet-recorded");
    expect(defaultRequestId(data, "missing-selection")).toBe("missing-selection");
    data.selection.requestId = null;
    data.captures = [];
    expect(defaultRequestId(data, null)).toBeNull();
  });
  it("默认在服务端分页前排除传输事件，高级类别仍可读全部记录", () => {
    const defaults = (new URL(listPath("t", {}), "http://localhost").searchParams.get("category") ?? "").split(",");
    expect(defaults).toEqual(["trace", "capture", "tool", "context", "compaction", "legacy-compaction", "message"]);
    expect(new URL(listPath("t", { category: "ui" }), "http://localhost").searchParams.get("category")).toBe("ui");
    expect(matchesCategory({ ...row("ui:one"), category: "ui" }, "")).toBe(false);
    expect(matchesCategory({ ...row("ui:one"), category: "ui" }, "ui")).toBe(true);
    expect(matchesCategory({ ...row("ui:one"), category: "ui" }, "all")).toBe(true);
    const html = renderToStaticMarkup(createElement(TraceInspector, { workspace: "w", taskId: "t", tasks: [], revision: 0,
      onClose: () => {}, onOpenTurn: () => {}, onOpenFile: () => {} }));
    expect(html).toContain("传输事件");
    expect(html).toContain("全部记录");
  });
  it.each([
    ["not_applicable", "not_applicable", "不适用", "不适用"],
    ["pending", "pending", "进行中", "进行中"],
    ["not_recorded", "provider_unavailable", "未记录", "模型未提供"],
    [undefined, undefined, "未记录", "未记录"],
  ])("总览指标如实区分 %s / %s，兼容旧DTO", (durationState, tokenState, duration, tokens) => {
    const data = detail();
    Object.assign(data.row, { durationMs: null, tokens: null, durationState, tokenState });
    const html = renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, "overview")));
    expect(html).toContain(`<dt>耗时</dt><dd>${duration}</dd>`);
    expect(html).toContain(`<dt>Token</dt><dd>${tokens}</dd>`);
  });
  it("字段标记显示正文预览与加载入口，而不冒充模型正文", () => {
    const html = renderToStaticMarkup(createElement(JsonView, { label: "长请求", value: {
      messages: [{ role: "user", content: fieldPreview() }], choices: [{ finish_reason: "stop" }]
    } }));
    expect(html).toContain("正文预览");
    expect(html).toContain("加载完整");
    expect(html).toContain("脱敏正文预览");
    expect(html).toContain("finish_reason");
    expect(html).not.toContain("__inspectorField");
  });
  it.each(["overview", "context-flow", "llm-request", "llm-response", "tool-calls", "compaction", "raw"] as const)("%s 支持结构化长字段且不显示误导性全局截断警告", (tab) => {
    const data = detail();
    data.truncated = true;
    data.limitations = ["字段 request_body_json 保留预览，可按需加载"];
    data.record = { payload: fieldPreview() };
    data.events = [{ id: "event", type: "context.compaction.started", source: "LLM", turnId: "turn", payload: { content: fieldPreview() }, createdAt: data.row.time, relation: "direct" }];
    data.captures[0].requestBody = { messages: [{ role: "user", content: fieldPreview() }] };
    data.captures[0].responseBody = { choices: [{ message: { content: fieldPreview(), tool_calls: [{ id: "call", function: { name: "read_file" } }] }, finish_reason: "tool_calls" }], wire: fieldPreview("response_body_json", ["wire"]) };
    data.tools = [{ id: "tool", intentId: "call", turnId: "turn", name: "read_file", round: 1, status: "completed", input: { path: "x" }, output: { content: fieldPreview("output_json", ["content"], "tool:tool") }, errorMessage: null, startedAt: data.row.time, completedAt: data.row.time, relation: "direct" }];
    data.context.pack = { id: "pack", content: fieldPreview("content", [], "context:pack") };
    const html = renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, tab)));
    expect(html).not.toContain('<p class="ti-warning">未查完或字段已截断</p>');
    expect(html).toContain("正文预览");
    expect(html).not.toContain("__inspectorField");
    if (tab === "llm-response") {
      expect(html).toContain("响应正文");
      expect(html).toContain("read_file");
      expect(html).toContain("Wire");
    }
  });
  it("来源快照同样识别按需字段，不展示内部标记", () => {
    const html = renderToStaticMarkup(createElement(TraceInspectorSource, { source: "source-ref", snapshot: { content: fieldPreview() }, file: false, truncated: false, onClose: () => {} }));
    expect(html).toContain("正文预览");
    expect(html).not.toContain("__inspectorField");
  });
  it("通用事实字段与摘要正文识别字段标记，不渲染object Object", () => {
    const html = renderToStaticMarkup(createElement(Facts, { items: [["长字段", fieldPreview()]] }));
    expect(html).toContain("加载完整");
    expect(html).not.toContain("__inspectorField");
    const data = detail();
    data.compactions = [{ id: "entry", taskId: "t", seq: 1, baseEntryId: null, firstKeptSourceRef: "source",
      coveredSourceRefs: [], summaryMarkdown: fieldPreview("summary_markdown", [], "compaction:entry") as unknown as string,
      details: {}, requestId: "old", requestIds: ["old"], createdAt: data.row.time, commitStatus: "committed",
      completionEventStatus: "recorded", tokensBefore: { value: 10, kind: "estimate", availability: "recorded" },
      tokensAfter: { value: null, kind: "estimate", availability: "unavailable" }, relation: "direct" }];
    const summary = renderToStaticMarkup(createElement(TraceInspectorDetails, { ...detailProps(data, "compaction"), compactionEntryId: "entry", compactionTab: "summary" }));
    expect(summary).toContain("加载完整");
    expect(summary).not.toContain("[object Object]");
  });
  it("工具未结束时耗时显示进行中，已完成但未记录结束时间时不编造耗时", () => {
    const data = detail();
    data.tools = [{ id: "tool", intentId: "call", turnId: "turn", name: "read_file", round: 1, status: "running", input: {}, output: null,
      errorMessage: null, startedAt: data.row.time, completedAt: null, relation: "direct" }];
    const html = renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, "tool-calls")));
    expect(html).toContain("<dt>耗时</dt><dd>进行中</dd>");
    data.tools[0].status = "completed";
    expect(renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, "tool-calls")))).toContain("<dt>耗时</dt><dd>未记录</dd>");
  });
  it.each(["overview", "context-flow", "llm-request", "llm-response", "tool-calls", "compaction", "raw"] as const)("%s 容忍工具失败长错误标记，表格与Facts都提供正文读取", (tab) => {
    const data = detail();
    data.tools = [{ id: "failed-tool", intentId: "call", turnId: "turn", name: "read_file", round: 1, status: "failed", input: { path: "x" }, output: null,
      errorMessage: fieldPreview("error_message", [], "tool:failed-tool"), startedAt: data.row.time, completedAt: data.row.time, relation: "direct" }];
    const html = renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, tab)));
    expect(html).not.toContain("[object Object]");
    expect(html).not.toContain("__inspectorField");
    if (tab === "tool-calls") {
      expect(html.match(/data-field="error_message"/g)).toHaveLength(2);
      expect(html.match(/>加载完整</g)).toHaveLength(2);
    }
  });
  it("默认字段分页交给服务端配置，仍支持显式limit", () => {
    const marker = fieldPreview("error_message", [], "tool:failed-tool");
    const defaults = new URL(inspectorFieldPath(marker), "http://localhost");
    expect(defaults.searchParams.get("offset")).toBe("0");
    expect(defaults.searchParams.has("limit")).toBe(false);
    const explicit = new URL(inspectorFieldPath(marker, 2048, 1024), "http://localhost");
    expect(explicit.searchParams.get("limit")).toBe("1024");
    expect(explicit.searchParams.get("offset")).toBe("2048");
  });
  it("工具详情复用事实耗时而不自行解析日期，scope DTO优先且兼容旧DTO", () => {
    const data = detail();
    data.row = { ...row("tool:tool"), category: "tool", durationMs: 12, durationState: "recorded", refs: { toolCallId: "tool" } };
    data.tools = [{ id: "tool", intentId: "call", turnId: "turn", name: "read_file", round: 1, status: "failed", input: {}, output: null,
      errorMessage: null, startedAt: "无效开始时间", completedAt: "无效结束时间", relation: "direct" }];
    const render = () => renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, "tool-calls")));
    expect(render()).toContain("<dt>耗时</dt><dd>12 ms</dd>");
    Object.assign(data.tools[0], { durationMs: 21, durationState: "recorded" });
    expect(render()).toContain("<dt>耗时</dt><dd>21 ms</dd>");
    Object.assign(data.tools[0], { durationMs: null, durationState: "not_recorded" });
    expect(render()).toContain("<dt>耗时</dt><dd>未记录</dd>");
  });
  it.each([NaN, Infinity, -1, 0.5])("非法耗时 %s 不显示成实测，数字零仍有效", (durationMs) => {
    expect(durationText({ durationMs, durationState: "recorded" })).toBe("未记录");
    expect(durationText({ durationMs: 0, durationState: "recorded" })).toBe("0 ms");
  });
  it("非JSON的模型响应仍保留正文，不因结构化展示丢失错误响应", () => {
    const data = detail(); data.captures[0].responseBody = "上游返回的纯文本错误响应";
    const html = renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(data, "llm-response")));
    expect(html).toContain("上游返回的纯文本错误响应");
  });
  it("原始整页JSON明确声明局部加载不合并其他视图", () => {
    const html = renderToStaticMarkup(createElement(TraceInspectorDetails, detailProps(detail(), "raw")));
    expect(html).toContain("不包含其他标签或视图按需加载的内容");
  });
  it("来源未返回且详情已截断时，不把未加载冒充原文不存在", () => {
    const html = renderToStaticMarkup(createElement(TraceInspectorSource, { source: "source-ref", snapshot: null, file: false, truncated: true, onClose: () => {} }));
    expect(html).toContain("来源记录尚未全部加载");
    expect(html).not.toContain("没有可重建的执行时快照");
  });
  it("总览工具链接定位 ToolCall，不把对象 ID 当作消息 sourceRef", () => {
    const data = detail();
    data.tools = [
      {
        id: "actual-tool",
        intentId: "model-intent",
        turnId: "turn",
        name: "read_file",
        round: 1,
        status: "completed",
        input: { path: "说明.md" },
        output: { content: "真实工具输出" },
        errorMessage: null,
        startedAt: "2026-10-16 12:00:00.000",
        completedAt: "2026-10-16 12:00:00.100",
        relation: "direct",
      },
    ];
    const tools: string[] = [],
      sources: string[] = [];
    const props = {
      detail: data,
      tab: "overview" as const,
      requestId: "old",
      compactionEntryId: null,
      onRequest: () => {},
      onCompaction: () => {},
      onSource: (ref: string) => sources.push(ref),
      onTool: (id: string) => tools.push(id),
      onOpenFile: () => {},
      onOpenTurn: () => {},
    };
    let click: (() => void) | undefined;
    const visit = (node: ReactNode): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (
        !isValidElement<{
          children?: ReactNode;
          "data-tool-id"?: string;
          onClick?: () => void;
        }>(node)
      )
        return;
      if (node.props["data-tool-id"] === "actual-tool")
        click = node.props.onClick;
      visit(node.props.children);
    };
    visit(TraceInspectorDetails(props));
    expect(click).toBeTypeOf("function");
    click!();
    expect(tools).toEqual(["actual-tool"]);
    expect(sources).toEqual([]);
    const focused = inspectorReducer(
      { ...initialInspectorState("workspace", "t"), requestId: "old" },
      { type: "focus", key: "tool:actual-tool" },
    );
    expect(
      detailPath(focused.selectedKey!, "tool-calls", focused.requestId),
    ).toBe("/api/v1/trace-inspector/events/tool%3Aactual-tool/tool-calls");
    const html = renderToStaticMarkup(
      createElement(TraceInspectorDetails, props),
    );
    expect(html).toContain('data-tool-id="actual-tool"');
  });
  it("上下文流先展示四阶段、投影和切点，完整构建 JSON 默认折叠", () => {
    const data = detail();
    data.context.pack = { id: "pack-old", estimatedTokens: 300 };
    data.context.items = [
      {
        id: "file-one",
        sourceType: "file_reference",
        sourceRef: "说明.md#L1-L2",
        content: "历史正文",
        included: true,
      },
    ];
    const html = renderToStaticMarkup(
      createElement(TraceInspectorDetails, {
        detail: data,
        tab: "context-flow",
        requestId: "old",
        compactionEntryId: null,
        onRequest: () => {},
        onCompaction: () => {},
        onTool: () => {},
        onSource: () => {},
        onOpenFile: () => {},
        onOpenTurn: () => {},
      }),
    );
    expect(html.match(/class="ti-flow-stage"/g)).toHaveLength(4);
    expect(html).toContain("文件 / SQLite");
    expect(html).toContain("摘要 / 保留消息");
    expect(html).toContain('href="#ti-context-projection"');
    expect(html).toContain('href="#ti-context-request"');
    expect(html).toContain('id="ti-context-projection"');
    expect(html).toContain('id="ti-context-boundary"');
    expect(html.indexOf('id="ti-context-projection"')).toBeLessThan(
      html.indexOf('class="ti-pack-json"'),
    );
    expect(html).toContain('<details class="ti-pack-json">');
    expect(html).toContain('<details class="ti-limitations">');
    expect(html).toContain("来源未知；以实际请求正文为准");
  });
  it("语义类型筛选包含关联Trace而不混入其他事件；文件差异按执行时行范围比较", () => {
    expect(
      matchesCategory(
        { ...row("trace"), category: "trace", kind: "llm.called" },
        "llm",
      ),
    ).toBe(true);
    expect(
      matchesCategory(
        { ...row("trace"), category: "trace", kind: "policy.denied" },
        "tool",
      ),
    ).toBe(true);
    expect(
      matchesCategory(
        { ...row("trace"), category: "trace", kind: "llm.called" },
        "tool",
      ),
    ).toBe(false);
    expect(
      snapshotDifference("说明.md#L2-L3", "原文\n末行", "首行\n修改\n末行"),
    ).toBe(true);
    expect(
      snapshotDifference(
        "说明.md#L2-L3",
        "原文\n末行",
        "首行\r\n原文\r\n末行\r\n",
      ),
    ).toBe(false);
    expect(snapshotDifference("说明.md", "原文", null)).toBeNull();
  });
  it("真实异步交错丢弃旧请求，返回同名 Task 也不会复活旧读取", async () => {
    const gate = new InspectorRequestGate();
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    let rendered = "";
    const first = gate.begin();
    const response = pending.then((value) => {
      if (gate.current(first)) rendered = value;
    });
    gate.cancel(first);
    const second = gate.begin();
    expect(gate.current(second)).toBe(true);
    rendered = "当前工作区的当前请求";
    release("旧工作区的过期内容");
    await response;
    expect(rendered).toBe("当前工作区的当前请求");
    expect(fileReferencePath("目录/说明#版本.md#L2-L8")).toBe(
      "目录/说明#版本.md",
    );
  });
  it("筛选切换与 Live 尾窗口始终替换列表，仅同查询手动分页追加", () => {
    expect(canAppendPage("more", "tool", "tool", 200)).toBe(true);
    expect(canAppendPage("more", "tool", "capture", 200)).toBe(false);
    expect(canAppendPage("live", "tool", "capture", 200)).toBe(false);
    expect(canAppendPage("live", "tool", "tool", 200)).toBe(false);
    expect(canAppendPage("initial", "tool", "tool", 200)).toBe(false);
    expect(canAppendPage("more", "tool", "tool", 500)).toBe(false);
    expect(listPath("task", { latest: true, limit: 500 })).toBe(
      "/api/v1/tasks/task/trace-inspector/events?category=trace%2Ccapture%2Ctool%2Ccontext%2Ccompaction%2Clegacy-compaction%2Cmessage&limit=500&latest=true",
    );
  });
  it("没有明确请求或条目时不采用当前最新记录", () => {
    const data = detail();
    const html = renderToStaticMarkup(
      createElement(TraceInspectorDetails, {
        detail: data,
        tab: "llm-request",
        requestId: null,
        compactionEntryId: null,
        onRequest: () => {},
        onCompaction: () => {},
        onTool: () => {},
        onSource: () => {},
        onOpenFile: () => {},
        onOpenTurn: () => {},
      }),
    );
    expect(html).toContain("请选择请求");
    expect(html).not.toContain("历史原文");
    expect(html).not.toContain("最新摘要");
  });
  it("全屏视图 SSR 提供七标签、任务与请求选择及稳定测试入口", () => {
    const html = renderToStaticMarkup(
      createElement(TraceInspector, {
        workspace: "工作区",
        taskId: "t",
        tasks: [],
        revision: 0,
        onClose: () => {},
        onOpenTurn: () => {},
        onOpenFile: () => {},
      }),
    );
    expect(html).toContain('data-testid="trace-inspector"');
    expect(html).toContain('data-testid="ti-event-table"');
    expect(html).toContain('aria-label="一级标签"');
    expect(html.match(/role="tab"/g)).toHaveLength(7);
    expect(html).toContain('aria-label="请求选择"');
    expect(html).toContain('aria-label="任务"');
    expect(html).toContain("暂无符合条件的事件");
  });
  it("Live 合并与分页去重不抢走历史事件和请求", () => {
    let state = inspectorReducer(initialInspectorState("workspace", "t"), {
      type: "page",
      scope: "workspace\u0000t",
      page: {
        rows: [row("old", "r-old")],
        hasMore: true,
        nextCursor: "next",
        truncated: true,
      },
      append: false,
    });
    state = inspectorReducer(state, {
      type: "select",
      row: row("old", "r-old"),
    });
    state = inspectorReducer(state, {
      type: "page",
      scope: state.scope,
      page: {
        rows: [row("old", "r-old"), row("new", "r-new")],
        hasMore: false,
        nextCursor: null,
        truncated: false,
      },
      append: true,
    });
    expect(state.rows.map((item) => item.key)).toEqual(["old", "new"]);
    expect(state.selectedKey).toBe("old");
    expect(state.requestId).toBe("r-old");
  });
  it("工作区和 Task 切换后丢弃迟到列表；错误保留旧数据", () => {
    const state = inspectorReducer(initialInspectorState("b", "t"), {
      type: "page",
      scope: "a\u0000t",
      page: {
        rows: [row("late")],
        hasMore: false,
        nextCursor: null,
        truncated: false,
      },
      append: false,
    });
    expect(state.rows).toEqual([]);
    const loaded = { ...state, rows: [row("kept")] };
    expect(
      inspectorReducer(loaded, { type: "error", error: "断网" }).rows,
    ).toEqual(loaded.rows);
  });
  it("URL 对 eventKey 和选择参数完整编码，overview 没有后缀", () => {
    const path = detailPath(
      "message:source/a?#",
      "overview",
      "req/a",
      "entry?#",
    );
    expect(path).toBe(
      "/api/v1/trace-inspector/events/message%3Asource%2Fa%3F%23?requestId=req%2Fa&compactionEntryId=entry%3F%23",
    );
    expect(
      listPath("task/a", {
        category: "tool",
        failed: true,
        q: "中文路径",
        cursor: "next/a",
      }),
    ).toContain("category=tool&failed=true&q=");
  });
  it("未知和负缩减保持真实；非法布局回默认值", () => {
    expect(reduction(100, null)).toBeNull();
    expect(reduction(100, 120)).toBeCloseTo(-0.2);
    expect(decodeLayout('{"ratio":99}')).toBe(52);
  });
  it("复制与导出再次脱敏并声明加载范围", () => {
    expect(
      JSON.stringify(
        redact({
          Authorization: "bearer x",
          apiKey: "abc",
          totalTokens: 42,
          body: "Authorization: Bearer abc-def",
        }),
      ),
    ).not.toContain("abc");
    const result = exportEvidence([row("one")], true, "json", "t");
    expect(JSON.parse(result).truncated).toBe(true);
    expect(JSON.parse(result).loadedRows).toBe(1);
    expect(JSON.stringify(redact({ totalTokens: 42 }))).toContain("42");
  });
  it("请求页只展示选中历史请求，响应同时展示过程正文和原生调用及未知 usage", () => {
    const props = {
      detail: detail(),
      requestId: "old",
      compactionEntryId: null,
      onRequest: () => {},
      onCompaction: () => {},
      onTool: () => {},
      onSource: () => {},
      onOpenFile: () => {},
      onOpenTurn: () => {},
    };
    const html = renderToStaticMarkup(
      createElement(TraceInspectorDetails, { ...props, tab: "llm-request" }),
    );
    expect(html).toContain("历史原文");
    expect(html).not.toContain("最新摘要");
    expect(html).not.toContain("secret-value");
    const response = renderToStaticMarkup(
      createElement(TraceInspectorDetails, { ...props, tab: "llm-response" }),
    );
    expect(response).toContain("读取过程说明");
    expect(response).toContain("read_file");
    expect(response).toContain("模型未提供");
  });
  it("Markdown 摘要安全预览，历史条目不会替换为最新条目", () => {
    const data = detail();
    data.compactions = ["old-entry", "new-entry"].map((id) => ({
      id,
      taskId: "t",
      seq: 1,
      baseEntryId: null,
      firstKeptSourceRef: "source:1",
      coveredSourceRefs: ["source:0"],
      summaryMarkdown:
        id === "old-entry"
          ? "## 旧摘要\n<script>alert('x')</script>"
          : "最新摘要禁止替换",
      details: {},
      requestId: "old",
      requestIds: ["old", "new"],
      createdAt: "2026-10-16 12:00:00.001",
      commitStatus: "committed",
      completionEventStatus: "missing",
      tokensBefore: { value: 100, kind: "estimate", availability: "recorded" },
      tokensAfter: {
        value: null,
        kind: "estimate",
        availability: "unavailable",
      },
      relation: "direct",
    }));
    const html = renderToStaticMarkup(
      createElement(TraceInspectorDetails, {
        detail: data,
        tab: "compaction",
        compactionTab: "summary",
        requestId: "old",
        compactionEntryId: "old-entry",
        onRequest: () => {},
        onCompaction: () => {},
        onTool: () => {},
        onSource: () => {},
        onOpenFile: () => {},
        onOpenTurn: () => {},
      }),
    );
    expect(html).toContain("旧摘要");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("最新摘要禁止替换");
    expect(html).toContain("old-entry");
  });
});
