import { describe, expect, it, vi } from "vitest";
import { listModelIds, listModelMetadata } from "../../src/config/model-catalog.js";

describe("model catalog", () => {
  it("reads only declared endpoint limits and keeps the model-id list contract", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "known", context_window: 128000, max_output_tokens: 16000 },
      { id: "unknown" }, { id: "invalid", context_window: -1, max_output_tokens: "8000" }
    ] }), { status: 200 }));
    const connection = { baseUrl: "https://relay.example/v1", apiKey: "test-key" };
    const models = await listModelMetadata(connection, fetchImpl as unknown as typeof fetch);
    expect(models.find((item) => item.id === "known")).toMatchObject({ contextWindow: 128000, maxTokens: 16000, metadataSource: "https://relay.example/v1/models" });
    expect(models.find((item) => item.id === "unknown")).toEqual({ id: "unknown" });
    expect(models.find((item) => item.id === "invalid")).toEqual({ id: "invalid" });
    expect(await listModelIds(connection, fetchImpl as unknown as typeof fetch)).toEqual(["invalid", "known", "unknown"]);
  });
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
