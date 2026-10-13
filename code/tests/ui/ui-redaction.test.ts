import { expect, it } from "vitest";
import { redactForUi } from "../../src/ui/ui-redaction.js";

it("redacts secret query parameters in capture URLs", () => {
  const capture = {
    url: "https://example.test/v1/chat?api_key=abc123&access_token=def456&q=hello",
    headers: { Authorization: "Bearer abc123" }
  };
  const redacted = redactForUi(capture) as { url: string; headers: { Authorization: string } };
  expect(redacted.url).toContain("q=hello");
  expect(redacted.url).not.toContain("abc123");
  expect(redacted.url).not.toContain("def456");
  expect(redacted.headers.Authorization).toBe("[REDACTED]");
});

it("keeps workspace paths in visible content while redacting secrets", () => {
  const root = "/Users/example/projects/figo-wiki";
  const content = `当前项目路径是 ${root}，密钥 sk-test-secret-long-enough`;
  expect(redactForUi(content)).toBe(`当前项目路径是 ${root}，密钥 [REDACTED]`);
});
