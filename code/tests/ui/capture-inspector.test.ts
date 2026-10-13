import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Capture } from "../../web/src/api.js";
import { CaptureInspector } from "../../web/src/Inspectors.js";

function capture(index: number, purpose: string): Capture {
  return {
    id: `capture_${index}`, requestId: `request_${index}`, purpose,
    provider: "deepseek", model: "deepseek-v4-pro", method: "POST", url: "https://example.test/chat",
    durationMs: 100, createdAt: "2026-10-13 23:00:00.000", responseStatus: 200, responseStatusText: "OK",
    requestHeaders: {}, requestBody: {}, responseHeaders: {}, responseBody: {},
    usage: { status: "complete", promptTokens: 1, completionTokens: 1, totalTokens: 2 }
  };
}

describe("CaptureInspector", () => {
  it("counts dialogue and compaction separately and defaults to dialogue requests", () => {
    const captures = [
      ...Array.from({ length: 23 }, (_, index) => capture(index, "turn")),
      ...Array.from({ length: 5 }, (_, index) => capture(index + 23, "round_compaction"))
    ];
    const html = renderToStaticMarkup(createElement(CaptureInspector, { captures, focusRequestId: null }));

    expect(html).toContain("对话调用 23");
    expect(html).toContain("压缩请求 5");
    expect(html).toContain("全部 HTTP (28)");
    expect(html.match(/data-capture-item=/g)).toHaveLength(23);
    expect(html).not.toContain("28 次请求");
  });

  it("shows compaction captures when there are no dialogue requests", () => {
    const captures = [capture(1, "round_compaction")];
    const html = renderToStaticMarkup(createElement(CaptureInspector, { captures, focusRequestId: null }));

    expect(html).toContain("压缩请求 1");
    expect(html.match(/data-capture-item=/g)).toHaveLength(1);
  });
});
