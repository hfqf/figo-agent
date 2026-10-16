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
} from "../../web/src/trace-inspector-state.js";
import { TraceInspectorDetails } from "../../web/src/TraceInspectorDetails.js";
import { TraceInspectorSource } from "../../web/src/TraceInspectorSource.js";
import { TraceInspector } from "../../web/src/TraceInspector.js";

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

describe("Trace Inspector 前端行为", () => {
  it("来源未返回且详情已截断时，不把未加载冒充原文不存在", () => {
    const html = renderToStaticMarkup(createElement(TraceInspectorSource, { source: "source-ref", snapshot: null, file: false, truncated: true, onClose: () => {} }));
    expect(html).toContain("未查完或字段已截断");
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
      "/api/v1/tasks/task/trace-inspector/events?limit=500&latest=true",
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
