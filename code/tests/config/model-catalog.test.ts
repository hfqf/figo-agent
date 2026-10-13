import { describe, expect, it, vi } from "vitest";
import { listModelIds } from "../../src/config/model-catalog.js";

describe("model catalog", () => {
  it("uses the configured endpoint and key, returning unique model ids only", async () => {
    const fetchImpl = vi.fn(async (_url: string, _options: RequestInit) => new Response(JSON.stringify({ data: [
      { id: "gpt-b" }, { id: "gpt-a" }, { id: "gpt-b" }, { id: "" }, { name: "missing-id" }
    ] }), { status: 200 }));
    const ids = await listModelIds({ baseUrl: "https://relay.example/v1/", apiKey: "test-secret" }, fetchImpl as unknown as typeof fetch);
    expect(ids).toEqual(["gpt-a", "gpt-b"]);
    expect(fetchImpl).toHaveBeenCalledWith("https://relay.example/v1/models", expect.objectContaining({
      headers: { Authorization: "Bearer test-secret" }, redirect: "error"
    }));
  });

  it("does not leak response bodies or keys in discovery errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret in error body", { status: 401 }));
    await expect(listModelIds({ baseUrl: "https://api.example/v1", apiKey: "test-secret" }, fetchImpl as unknown as typeof fetch))
      .rejects.toThrow("模型列表请求失败：401");
  });
});
