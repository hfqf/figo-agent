import { expect, it } from "vitest";
import { redactForUi } from "../../src/ui/ui-redaction.js";

it("轮换密钥存在前缀重叠时先替换完整长值，不泄露后缀且不改变调用方数组", () => {
  const secrets = ["fixture-value", "fixture-value-rotated"];
  expect(redactForUi("fixture-value fixture-value-rotated", secrets)).toBe("[REDACTED] [REDACTED]");
  expect(secrets).toEqual(["fixture-value", "fixture-value-rotated"]);
});

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

it("脱敏正文中的凭据赋值，不误删 token 统计或来源引用", () => {
  const content = 'apiKey: local-value\npassword="with spaces"\nAuthorization: Basic abc123\naccess_token=access-value\nsecret: private-value\nprompt_tokens: 42\nsourceRef: tool:abc:result';
  const safe = String(redactForUi(content));
  for (const secret of ["local-value", "with spaces", "abc123", "access-value", "private-value"]) expect(safe).not.toContain(secret);
  expect(safe).toContain("prompt_tokens: 42");
  expect(safe).toContain("sourceRef: tool:abc:result");
  expect(String(redactForUi('password="unfinished-private-value')).includes("unfinished-private-value")).toBe(false);
});
