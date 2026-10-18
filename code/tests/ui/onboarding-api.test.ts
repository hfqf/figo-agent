import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AgentKernel } from "../../src/kernel/agent-kernel.js";
import { startLocalApi } from "../../src/ui/local-api.js";

it("引导关闭需 CSRF，校验图名和版本，不创建 Turn 或 UI 执行事件，重启仍保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "figo-onboarding-api-"));
  const configRoot = join(root, "config");
  const kernel = await AgentKernel.start({ workspaceRoot: root });
  let api = await startLocalApi({ kernel, port: 0, configRoot, requireAccessCode: false });
  try {
    const boot = await (await fetch(`${api.url}/api/v1/bootstrap`)).json();
    expect(boot.onboarding).toEqual({ enabled: true, revision: "1", seen: [] });
    const initialTurns = kernel.storage.db.prepare("select count(*) n from turns").get();
    const initialCursor = api.coordinator.events.cursor();
    const save = (body: unknown, csrf = boot.csrf) => fetch(`${api.url}/api/v1/settings/onboarding`, {
      method: "PUT", headers: { origin: api.url, "x-figo-csrf": csrf, "content-type": "application/json" }, body: JSON.stringify(body)
    });
    expect((await save({ guide: "workbench", revision: "1" }, "bad")).status).toBe(403);
    expect((await save({ guide: "unknown", revision: "1" })).status).toBe(400);
    expect((await save({ guide: "workbench", revision: "old" })).status).toBe(400);
    expect((await save(null)).status).toBe(400);
    expect((await save({ guide: "workbench", revision: "1" })).status).toBe(200);
    expect((await save({ guide: "workbench", revision: "1" })).status).toBe(200);
    expect(kernel.storage.db.prepare("select count(*) n from turns").get()).toEqual(initialTurns);
    expect(api.coordinator.events.cursor()).toBe(initialCursor);
    await api.close();
    api = await startLocalApi({ kernel, port: 0, configRoot, requireAccessCode: false });
    expect((await (await fetch(`${api.url}/api/v1/bootstrap`)).json()).onboarding.seen).toEqual(["workbench"]);
  } finally {
    await api.close(); await kernel.shutdown(); kernel.storage.db.close();
    await rm(root, { recursive: true, force: true });
  }
});
