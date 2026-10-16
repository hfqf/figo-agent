export interface ModelConnection { baseUrl: string; apiKey: string }
export interface ModelMetadata { id: string; contextWindow?: number; maxTokens?: number; metadataSource?: string }

export async function listModelIds(connection: ModelConnection, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  return (await listModelMetadata(connection, fetchImpl)).map((model) => model.id);
}

export async function listModelMetadata(connection: ModelConnection, fetchImpl: typeof fetch = fetch): Promise<ModelMetadata[]> {
  const baseUrl = connection.baseUrl.trim().replace(/\/+$/, "");
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error("模型地址无效。"); }
  if (!connection.apiKey.trim() || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("模型列表连接配置无效。");
  }
  const response = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${connection.apiKey}` },
    redirect: "error", signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`模型列表请求失败：${response.status}。`);
  }
  const body = await response.text();
  if (body.length > 2_000_000) throw new Error("模型列表响应过大。");
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new Error("模型列表响应无效。"); }
  if (!value || typeof value !== "object" || !Array.isArray((value as { data?: unknown }).data)) throw new Error("模型列表响应无效。");
  const models = new Map<string, ModelMetadata>();
  for (const item of (value as { data: unknown[] }).data) {
    if (!item || typeof item !== "object" || !("id" in item) || typeof item.id !== "string" || !item.id.trim() || item.id.length > 200) continue;
    const data = item as Record<string, unknown>;
    const contextWindow = positiveInteger(data.context_window ?? data.context_length);
    const maxTokens = positiveInteger(data.max_output_tokens);
    models.set(item.id, { id: item.id, ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(contextWindow === undefined && maxTokens === undefined ? {} : { metadataSource: `${baseUrl}/models` }) });
  }
  return [...models.values()].sort((left, right) => left.id.localeCompare(right.id, "en")).slice(0, 1000);
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
