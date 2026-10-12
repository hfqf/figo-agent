import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { startLocalApi } from "../../src/ui/local-api.js";

let workspace = "";
afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = "";
});

describe("local API security", () => {
  it("opens the local workbench without a login when configured, while retaining same-origin write checks", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-open-"));
    await writeFile(join(workspace, "note.md"), "保存前\n");
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, requireAccessCode: false });
    try {
      const bootstrap = await fetch(`${api.url}/api/v1/bootstrap`);
      expect(bootstrap.status).toBe(200);
      const state = await bootstrap.json() as { tasks: Array<{ id: string }>; csrf: string };
      expect(state.csrf).toBeTruthy();

      const before = await fetch(`${api.url}/api/v1/file?path=note.md`);
      const version = (await before.json() as { version: string }).version;
      const saveUrl = `${api.url}/api/v1/file`;
      const deniedSave = await fetch(saveUrl, {
        method: "PUT", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "保存后\n", version })
      });
      expect(deniedSave.status).toBe(403);
      const savedResponse = await fetch(saveUrl, {
        method: "PUT", headers: { origin: api.url, "x-figo-csrf": state.csrf, "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "保存后\n", version })
      });
      expect(savedResponse.status).toBe(200);
      expect((await savedResponse.json() as { version: string }).version).not.toBe(version);
      const stale = await fetch(saveUrl, {
        method: "PUT", headers: { origin: api.url, "x-figo-csrf": state.csrf, "content-type": "application/json" },
        body: JSON.stringify({ path: "note.md", content: "错误覆盖", version })
      });
      expect(stale.status).toBe(409);
      expect((await (await fetch(`${api.url}/api/v1/file?path=note.md`)).json() as { content: string }).content).toBe("保存后\n");
      expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 0 });
      expect(kernel.storage.db.prepare("select kind from ui_events where kind = 'file.saved' order by seq desc limit 1").get()).toMatchObject({ kind: "file.saved" });

      const deniedOrigin = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { origin: "https://evil.example" } });
      expect(deniedOrigin.status).toBe(403);
      const turnUrl = `${api.url}/api/v1/tasks/${state.tasks[0].id}/turns`;
      const withoutCsrf = await fetch(turnUrl, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "no-login-1" })
      });
      expect(withoutCsrf.status).toBe(403);
      const accepted = await fetch(turnUrl, {
        method: "POST", headers: { origin: api.url, "x-figo-csrf": state.csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "no-login-1" })
      });
      expect(accepted.status).toBe(202);
      await api.coordinator.waitForIdle();
    } finally {
      await api.close();
    }
  });

  it("requires a local session and CSRF before exposing state or accepting a turn", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-api-"));
    await writeFile(join(workspace, "note.md"), "甲\n乙\n");
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    await writeFile(join(workspace, "figo-agent.config.json"), '{"apiKey":"local-secret"}');
    const api = await startLocalApi({ kernel, port: 0, accessCode: "test-access-code" });
    try {
      const unauthorized = await fetch(`${api.url}/api/v1/bootstrap`);
      expect(unauthorized.status).toBe(401);
      const wrongHost = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(`${api.url}/api/v1/bootstrap`, { headers: { Host: "evil.example" } }, (response) => {
          response.resume(); resolve(response.statusCode ?? 0);
        });
        request.on("error", reject); request.end();
      });
      expect(wrongHost).toBe(403);

      const evil = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "test-access-code" })
      });
      expect(evil.status).toBe(403);

      const nullAuth = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" }, body: "null"
      });
      expect(nullAuth.status).toBe(401);

      const auth = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "test-access-code" })
      });
      expect(auth.status).toBe(200);
      expect(auth.headers.get("set-cookie")).toContain("HttpOnly");
      expect(auth.headers.get("set-cookie")).toContain("SameSite=Strict");
      const cookie = auth.headers.get("set-cookie")!.split(";")[0];
      const csrf = (await auth.json() as { csrf: string }).csrf;
      const bootstrap = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { cookie } });
      expect(bootstrap.status).toBe(200);
      const state = await bootstrap.json() as { sessionId: string; tasks: Array<{ id: string }>; csrf: string };
      expect(state.sessionId).toBe(kernel.session.id);
      expect(state.csrf).toBe(csrf);

      const fileList = await fetch(`${api.url}/api/v1/files?path=`, { headers: { cookie } });
      expect(fileList.status).toBe(200);
      expect(JSON.stringify(await fileList.json())).toContain("note.md");
      const searchResults = await fetch(`${api.url}/api/v1/files/search?q=note`, { headers: { cookie } });
      expect(searchResults.status).toBe(200);
      expect(JSON.stringify(await searchResults.json())).toContain("note.md");
      const previewResponse = await fetch(`${api.url}/api/v1/file?path=note.md`, { headers: { cookie } });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { version: string };
      expect(kernel.storage.db.prepare("select count(*) as count from turns").get()).toEqual({ count: 0 });
      const secretFile = await fetch(`${api.url}/api/v1/file?path=figo-agent.config.json`, { headers: { cookie } });
      expect(secretFile.status).toBe(403);
      expect(JSON.stringify(await secretFile.json())).not.toContain("local-secret");
      expect(kernel.storage.db.prepare("select kind from ui_events where kind = 'file.denied' order by seq desc limit 1").get()).toMatchObject({ kind: "file.denied" });

      const turnUrl = `${api.url}/api/v1/tasks/${state.tasks[0].id}/turns`;
      const withoutCsrf = await fetch(turnUrl, {
        method: "POST", headers: { cookie, origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "test-1" })
      });
      expect(withoutCsrf.status).toBe(403);
      const accepted = await fetch(turnUrl, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "你好", clientRequestId: "test-1" })
      });
      expect(accepted.status).toBe(202);
      expect(await accepted.json()).toMatchObject({ status: "accepted", taskId: state.tasks[0].id });
      await api.coordinator.waitForIdle();
      const usageResponse = await fetch(`${api.url}/api/v1/tasks/${state.tasks[0].id}/usage`, { headers: { cookie } });
      expect(usageResponse.status).toBe(200);
      expect(await usageResponse.json()).toMatchObject({ requestCount: 1, unavailableCount: 1, totalReportedCount: 0 });

      const referenceRun = await fetch(turnUrl, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ input: "引用文件", clientRequestId: "test-ref", fileReferences: [
          { path: "note.md", startLine: 2, endLine: 2, version: preview.version }
        ] })
      });
      expect(referenceRun.status).toBe(202);
      const refRun = await referenceRun.json() as { turnId: string };
      await api.coordinator.waitForIdle();
      const contextResponse = await fetch(`${api.url}/api/v1/turns/${refRun.turnId}/context`, { headers: { cookie } });
      expect(contextResponse.status).toBe(200);
      expect(JSON.stringify(await contextResponse.json())).toContain("note.md#L2-L2");
      const captureResponse = await fetch(`${api.url}/api/v1/turns/${refRun.turnId}/captures`, { headers: { cookie } });
      expect(captureResponse.status).toBe(200);
      const traceResponse = await fetch(`${api.url}/api/v1/turns/${refRun.turnId}/trace`, { headers: { cookie } });
      expect(traceResponse.status).toBe(200);
      const toolsResponse = await fetch(`${api.url}/api/v1/tasks/${state.tasks[0].id}/tool-calls`, { headers: { cookie } });
      expect(toolsResponse.status).toBe(200);
      const newTask = await fetch(`${api.url}/api/v1/tasks`, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ title: "第二个 Task" })
      });
      expect(newTask.status).toBe(201);
      const switchBack = await fetch(`${api.url}/api/v1/tasks/${state.tasks[0].id}/actions`, {
        method: "POST", headers: { cookie, origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" },
        body: JSON.stringify({ action: "switch" })
      });
      expect(switchBack.status).toBe(200);
      const afterSwitch = await fetch(`${api.url}/api/v1/bootstrap`, { headers: { cookie } });
      expect((await afterSwitch.json() as { currentTaskId: string }).currentTaskId).toBe(state.tasks[0].id);
    } finally {
      await api.close();
    }
  });

  it("replays more than one event page and keeps streaming later events", async () => {
    workspace = await mkdtemp(join(tmpdir(), "figo-ui-api-"));
    const kernel = await AgentKernel.start({ workspaceRoot: workspace });
    const api = await startLocalApi({ kernel, port: 0, accessCode: "test-access-code" });
    const abort = new AbortController();
    try {
      const denied = await fetch(`${api.url}/api/v1/events?after=0`);
      expect(denied.status).toBe(401);
      const auth = await fetch(`${api.url}/api/v1/auth`, {
        method: "POST", headers: { origin: api.url, "content-type": "application/json" },
        body: JSON.stringify({ accessCode: "test-access-code" })
      });
      const cookie = auth.headers.get("set-cookie")!.split(";")[0];
      for (let index = 0; index < 510; index++) {
        api.coordinator.events.append({ sessionId: kernel.session.id, kind: "test.event", payload: { index } });
      }
      const response = await fetch(`${api.url}/api/v1/events?after=0`, { headers: { cookie }, signal: abort.signal });
      expect(response.status).toBe(200);
      api.coordinator.events.append({ sessionId: kernel.session.id, kind: "test.live", payload: {} });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let stream = "";
      await Promise.race([
        (async () => {
          while (!stream.includes("\"kind\":\"test.live\"")) {
            const chunk = await reader.read();
            if (chunk.done) break;
            stream += decoder.decode(chunk.value);
          }
        })(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("SSE replay timed out")), 2500))
      ]);
      expect((stream.match(/data: /g) ?? []).length).toBe(511);
    } finally {
      abort.abort();
      await api.close();
    }
  });
});
