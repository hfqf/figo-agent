import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { TraceInspectorPagination } from "../../web/src/TraceInspectorPagination.js";
import { listPath } from "../../web/src/trace-inspector-state.js";

const pagination = { totalCount: 525, page: 2, totalPages: 3, pageSize: 200, from: 201, to: 400 };
const props = { pagination, live: false, loaded: 200, loading: false, onPage() {}, onHistoryStart() {} };
it("分页明确展示筛选总数、当前页、总页数、页大小和当前范围", () => {
  const html = renderToStaticMarkup(createElement(TraceInspectorPagination, props));
  for (const text of ["共 525 条", "第 2 / 3 页", "本页 201-400 条", "每页 200 条", "上一页", "下一页", "首页", "末页"]) expect(html).toContain(text);
});
it("空结果显示0页而非虚构1页，导航全部禁用", () => {
  const html = renderToStaticMarkup(createElement(TraceInspectorPagination, { ...props, pagination: { ...pagination, totalCount: 0, page: 0, totalPages: 0, from: 0, to: 0 }, loaded: 0 }));
  expect(html).toContain("共 0 条"); expect(html).toContain("第 0 / 0 页");
  expect((html.match(/disabled=""/g) ?? []).length).toBe(4);
});
it("实时窗口显示真实总数与窗口条数，不把尾部窗口说成完整分页", () => {
  const html = renderToStaticMarkup(createElement(TraceInspectorPagination, { ...props, pagination: { ...pagination, page: null, totalPages: null, from: 26, to: 525 }, live: true, loaded: 500 }));
  expect(html).toContain("共 525 条"); expect(html).toContain("最新 500 条"); expect(html).toContain("实时窗口");
  expect(html).not.toContain("第 2 / 3 页"); expect(html).not.toContain('aria-label="下一页"');
});
it("页码及精确类别筛选进入服务端查询，旧接口仍可省略", () => {
  const url = new URL(listPath("task", { page: 2, group: "llm", category: "capture,trace" }), "http://localhost");
  expect(url.searchParams.get("page")).toBe("2"); expect(url.searchParams.get("group")).toBe("llm");
  expect(new URL(listPath("task", {}), "http://localhost").searchParams.has("page")).toBe(false);
});
