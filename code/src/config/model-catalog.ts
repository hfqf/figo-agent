export interface ModelConnection { baseUrl: string; apiKey: string }

export async function listModelIds(connection: ModelConnection, fetchImpl: typeof fetch = fetch): Promise<string[]> {
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
  const ids = (value as { data: unknown[] }).data
    .map((item) => item && typeof item === "object" && "id" in item ? item.id : null)
    .filter((id): id is string => typeof id === "string" && Boolean(id.trim()) && id.length <= 200);
  return [...new Set(ids)].sort((left, right) => left.localeCompare(right, "en")).slice(0, 1000);
}
