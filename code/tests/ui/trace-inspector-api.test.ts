import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { startLocalApi, type LocalApiHandle } from "../../src/ui/local-api.js";

let root = "";
let kernel: AgentKernel;
let api: LocalApiHandle;
afterEach(async () => {
  await api?.close();
  if (kernel?.storage.db.isOpen) kernel.storage.db.close();
  if (root) await rm(root, { recursive: true, force: true });
});

async function fixture(auth = false) {
  root = await mkdtemp(join(tmpdir(), "figo-inspector-api-"));
  kernel = await AgentKernel.start({ workspaceRoot: root });
  const turn = await kernel.submitTurn("检查器测试记录");
  api = await startLocalApi({ kernel, requireAccessCode: auth, accessCode: "fixture-code", secrets: ["fixture-private-value"] });
  return { turn, list: `${api.url}/api/v1/tasks/${turn.taskId}/trace-inspector/events` };
}

describe("Trace Inspector API", () => {
  it("当前文件通过独立脱敏预览读取，不修改编辑器协议或文件内容", async () => {
    await fixture();
    const content = 'password="fixture-only-pass"\nAuthorization: Basic fixture-basic\n本地说明';
    await writeFile(join(root, "本地说明.md"), content, "utf8");
    const path = encodeURIComponent("本地说明.md");
    const response = await fetch(`${api.url}/api/v1/trace-inspector/file?path=${path}`);
    expect(response.status).toBe(200);
    const safe = await response.text();
    expect(safe).not.toContain("fixture-only-pass");
    expect(safe).not.toContain("fixture-basic");
    expect(safe).toContain("本地说明");
    const editor = await (await fetch(`${api.url}/api/v1/file?path=${path}`)).json() as { content: string };
    expect(editor.content).toBe(content);
    expect((await fetch(`${api.url}/api/v1/trace-inspector/file?path=../outside`)).status).toBe(403);
  });
  it("沿用本地鉴权，未认证不能读列表与原始详情", async () => {
    const f = await fixture(true);
    expect((await fetch(f.list)).status).toBe(401);
    expect((await fetch(`${api.url}/api/v1/trace-inspector/events/trace%3Amissing/raw`)).status).toBe(401);
    expect((await fetch(`${api.url}/api/v1/trace-inspector/events/trace%3Amissing/field?field=payload_json`)).status).toBe(401);
    const auth = await fetch(`${api.url}/api/v1/auth`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessCode: "fixture-code" }) });
    const cookie = auth.headers.get("set-cookie")!.split(";")[0];
    expect((await fetch(f.list, { headers: { cookie } })).status).toBe(200);
  });

  it("查询列表和七种详情均为脱敏只读，不创建 Turn 或调用模型", async () => {
    const f = await fixture();
    const trace = kernel.storage.db.prepare("select id from trace_events where turn_id = ? order by rowid limit 1").get(f.turn.turnId) as { id: string };
    kernel.storage.db.prepare("update trace_events set payload_json = ? where id = ?")
      .run(JSON.stringify({ note: "fixture-private-value", apiKey: "fixture-key-value" }), trace.id);
    const before = kernel.storage.db.prepare("select (select count(*) from turns) as turns, (select count(*) from llm_http_captures) as captures").get();
    const response = await fetch(f.list);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const list = await response.json() as { events: Array<{ key: string }> };
    expect(list.events.length).toBeGreaterThan(0);
    const key = encodeURIComponent(`trace:${trace.id}`);
    for (const tab of ["", "/context-flow", "/llm-request", "/llm-response", "/tool-calls", "/compaction", "/raw"]) {
      const detail = await fetch(`${api.url}/api/v1/trace-inspector/events/${key}${tab}`);
      expect(detail.status, tab).toBe(200);
      const body = await detail.text();
      expect(body).not.toContain("fixture-private-value");
      expect(body).not.toContain("fixture-key-value");
    }
    expect(kernel.storage.db.prepare("select (select count(*) from turns) as turns, (select count(*) from llm_http_captures) as captures").get()).toEqual(before);
  });

  it("拒绝无效游标/参数和不属于所选事件的请求", async () => {
    const f = await fixture();
    expect((await fetch(`${f.list}?cursor=garbage`)).status).toBe(400);
    expect((await fetch(`${f.list}?limit=-1`)).status).toBe(400);
    expect((await fetch(`${f.list}?category=bad`)).status).toBe(400);
    expect((await fetch(`${f.list}?latest=bad`)).status).toBe(400);
    expect((await fetch(`${f.list}?latest=true&cursor=garbage`)).status).toBe(400);
    expect((await fetch(`${f.list}?latest=true&limit=2`)).status).toBe(200);
    const trace = kernel.storage.db.prepare("select id from trace_events where turn_id = ? limit 1").get(f.turn.turnId) as { id: string };
    const key = encodeURIComponent(`trace:${trace.id}`);
    expect((await fetch(`${api.url}/api/v1/trace-inspector/events/${key}?requestId=not-owned`)).status).toBe(400);
    expect((await fetch(`${api.url}/api/v1/trace-inspector/events/trace%3Amissing`)).status).toBe(404);
    expect((await fetch(`${f.list}`, { headers: { Origin: "http://untrusted.invalid" } })).status).toBe(403);
  });

  it("分页返回明确的剩余游标，写请求不能进入查询服务", async () => {
    const f = await fixture();
    const first = await (await fetch(`${f.list}?limit=2`)).json() as { events: Array<{ key: string }>; nextCursor: string; hasMore: boolean };
    expect(first.events).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    const next = await (await fetch(`${f.list}?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as { events: Array<{ key: string }> };
    expect(next.events.every((event) => !first.events.some((previous) => previous.key === event.key))).toBe(true);
    const boot = await (await fetch(`${api.url}/api/v1/bootstrap`)).json() as { csrf: string };
    const post = await fetch(f.list, { method: "POST", headers: { Origin: api.url, "X-Figo-CSRF": boot.csrf } });
    expect(post.status).toBe(405);
  });

  it("长字段分页保留脱敏与只读约束，拒绝任意列和非法路径", async () => {
    const f = await fixture();
    const db = kernel.storage.db;
    const trace = db.prepare("select id from trace_events where turn_id = ? limit 1").get(f.turn.turnId) as { id: string };
    db.prepare("update trace_events set payload_json = ? where id = ?").run(JSON.stringify({ note: "x".repeat(20000) + "fixture-private-value", apiKey: "secret-only-fixture" }), trace.id);
    const url = `${api.url}/api/v1/trace-inspector/events/${encodeURIComponent(`trace:${trace.id}`)}/field`;
    const before = db.prepare("select count(*) n from trace_events").get();
    const params = new URLSearchParams({ field: "payload_json", path: JSON.stringify(["note"]), offset: "19990", limit: "200" });
    const response = await fetch(`${url}?${params}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ content: "xxxxxxxxxx[REDACTED]", complete: true });
    for (const query of ["field=id", "field=payload_json&path=bad", 'field=payload_json&path=%7B%7D', 'field=payload_json&offset=-1', 'field=payload_json&limit=0', 'field=payload_json&field=payload_json']) {
      expect((await fetch(`${url}?${query}`)).status, query).toBe(400);
    }
    expect((await fetch(`${url}?field=payload_json`, { headers: { Origin: "http://untrusted.invalid" } })).status).toBe(403);
    expect(db.prepare("select count(*) n from trace_events").get()).toEqual(before);
  });
});
